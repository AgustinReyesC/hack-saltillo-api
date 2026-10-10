import { Module } from '@nestjs/common';
import { CommitmentsModule } from '../commitments/commitments.module.js';
import { InspectionHandlers } from './inspections.handlers.js';

@Module({
  imports: [CommitmentsModule],
  providers: [InspectionHandlers],
  exports: [InspectionHandlers],
})
export class InspectionsModule {}
