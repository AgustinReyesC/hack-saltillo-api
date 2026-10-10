import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CommitmentsService } from '../commitments/commitments.service.js';
import { Movement, toInt, toMovement } from '../common/serialization.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { EventEnvelope } from '../outbox/event-envelope.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { CountDto } from './dto/count.dto.js';
import { IssueDto } from './dto/issue.dto.js';
import { TransferDto } from './dto/transfer.dto.js';

// Comandos HTTP del contrato que mueven existencias: conteos, transferencias y salidas.
@Injectable()
export class InventoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly commitments: CommitmentsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // Regla 17: un ajuste por cada diferencia. Es la única operación que puede dejar
  // `available` negativo.
  async count(dto: CountDto) {
    return this.run(async (manager, events) => {
      await this.ledger.assertLocationExists(manager, dto.location_id);
      const partIds = dto.lines.map((line) => line.part_id);
      await this.ledger.assertPartsExist(manager, partIds);
      await this.ledger.lockParts(manager, partIds);

      const adjustments: { part_id: number; delta: number }[] = [];
      for (const line of dto.lines) {
        const onHand = await this.ledger.onHandAt(
          manager,
          line.part_id,
          dto.location_id,
        );
        const delta = line.counted_quantity - onHand;
        if (delta === 0) {
          continue;
        }
        const event = this.outbox.build(
          'stock.adjusted',
          `part:${line.part_id}`,
          {
            part_id: line.part_id,
            location_id: dto.location_id,
            delta,
            reason: dto.reason,
          },
        );
        await this.ledger.addMovement(manager, {
          type: 'adjustment',
          partId: line.part_id,
          locationId: dto.location_id,
          quantity: delta,
          reference: dto.reason,
          eventId: event.event_id,
        });
        await this.outbox.save(manager, event);
        events.push(event);
        adjustments.push({ part_id: line.part_id, delta });
      }

      await this.recomputeSuggestions(manager, partIds, events);
      return { adjustments };
    });
  }

  // Mueve existencia entre ubicaciones; el total de la pieza no cambia.
  async transfer(dto: TransferDto) {
    if (dto.from_location_id === dto.to_location_id) {
      throw new UnprocessableEntityException(
        'from_location_id and to_location_id must be different',
      );
    }

    return this.run(async (manager, events) => {
      await this.ledger.assertPartsExist(manager, [dto.part_id]);
      await this.ledger.assertLocationExists(manager, dto.from_location_id);
      await this.ledger.assertLocationExists(manager, dto.to_location_id);
      await this.ledger.lockParts(manager, [dto.part_id]);

      const onHand = await this.ledger.onHandAt(
        manager,
        dto.part_id,
        dto.from_location_id,
      );
      if (dto.quantity > onHand) {
        throw new ConflictException(
          `Insufficient stock at location ${dto.from_location_id}: ${onHand} on hand`,
        );
      }

      const event = this.outbox.build(
        'stock.transferred',
        `part:${dto.part_id}`,
        {
          part_id: dto.part_id,
          from_location_id: dto.from_location_id,
          to_location_id: dto.to_location_id,
          quantity: dto.quantity,
        },
      );
      const reference = `transfer:${event.event_id}`;
      const transferOut = await this.ledger.addMovement(manager, {
        type: 'transfer_out',
        partId: dto.part_id,
        locationId: dto.from_location_id,
        quantity: -dto.quantity,
        reference,
        eventId: event.event_id,
      });
      const transferIn = await this.ledger.addMovement(manager, {
        type: 'transfer_in',
        partId: dto.part_id,
        locationId: dto.to_location_id,
        quantity: dto.quantity,
        reference,
        eventId: event.event_id,
      });
      await this.outbox.save(manager, event);
      events.push(event);

      return {
        ...toMovement(transferOut),
        transfer_in_movement_id: toInt(transferIn.movement_id),
      };
    });
  }

  // Regla 16: baja el saldo de la ubicación y consume primero la reserva de la orden. Si no
  // alcanza, 409 sin mover nada.
  async issue(dto: IssueDto): Promise<Movement> {
    return this.run(async (manager, events) => {
      const [workOrder]: { work_order_id: number; code: string }[] =
        await manager.query(
          'SELECT work_order_id, code FROM work_order WHERE code = $1',
          [dto.work_order_code],
        );
      if (!workOrder) {
        throw new NotFoundException(
          `Work order ${dto.work_order_code} not found`,
        );
      }
      await this.ledger.assertPartsExist(manager, [dto.part_id]);
      await this.ledger.assertLocationExists(manager, dto.location_id);
      await this.ledger.lockParts(manager, [dto.part_id]);

      const onHand = await this.ledger.onHandAt(
        manager,
        dto.part_id,
        dto.location_id,
      );
      if (dto.quantity > onHand) {
        throw new ConflictException(
          `Insufficient stock at location ${dto.location_id}: ${onHand} on hand`,
        );
      }
      // Lo que exceda la reserva propia sale del disponible general.
      const own = await this.commitments.activeReserved(
        manager,
        workOrder.work_order_id,
        dto.part_id,
      );
      const extra = Math.max(dto.quantity - own, 0);
      const available = Math.max(
        await this.ledger.availableTotal(manager, dto.part_id),
        0,
      );
      if (extra > available) {
        throw new ConflictException(
          `Insufficient available stock: ${available} available beyond the work order reservation`,
        );
      }

      const event = this.outbox.build('stock.issued', workOrder.code, {
        work_order_id: workOrder.work_order_id,
        part_id: dto.part_id,
        location_id: dto.location_id,
        quantity: dto.quantity,
        issued_by: dto.issued_by,
      });
      const movement = await this.ledger.addMovement(manager, {
        type: 'issue',
        partId: dto.part_id,
        locationId: dto.location_id,
        quantity: -dto.quantity,
        reference: workOrder.code,
        eventId: event.event_id,
      });
      const consumed = Math.min(dto.quantity, own);
      await this.commitments.consumeReservations(
        manager,
        workOrder.work_order_id,
        dto.part_id,
        consumed,
      );
      await this.ledger.addReserved(manager, dto.part_id, -consumed);
      await this.outbox.save(manager, event);
      events.push(event);

      await this.recomputeSuggestions(manager, [dto.part_id], events);
      return toMovement(movement);
    });
  }

  private async recomputeSuggestions(
    manager: EntityManager,
    partIds: number[],
    events: EventEnvelope[],
  ): Promise<void> {
    for (const partId of new Set(partIds)) {
      const suggestion = await this.commitments.recomputeSuggestion(
        manager,
        partId,
      );
      if (suggestion) {
        events.push(suggestion);
      }
    }
  }

  // Ejecuta el comando en una transacción y avisa a la UI solo después del COMMIT.
  private async run<T>(
    work: (manager: EntityManager, events: EventEnvelope[]) => Promise<T>,
  ): Promise<T> {
    const events: EventEnvelope[] = [];
    const result = await this.dataSource.transaction((manager) =>
      work(manager, events),
    );
    this.realtime.notify(events);
    return result;
  }
}
