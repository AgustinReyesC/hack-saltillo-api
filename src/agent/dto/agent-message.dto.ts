import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class AgentMessageDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  // Datos que acompañan el mensaje (p. ej. las piezas a las que se refiere), para que la UI
  // los pueda renderizar.
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
