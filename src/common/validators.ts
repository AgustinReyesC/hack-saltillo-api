import { applyDecorators } from '@nestjs/common';
import {
  IsInt,
  Max,
  Min,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

// Las llaves de la base son INTEGER: fuera de ese rango Postgres falla; mejor un 422 claro.
export function IsInt32(): PropertyDecorator {
  return applyDecorators(IsInt(), Min(-2_147_483_648), Max(2_147_483_647));
}

// `issued_by` acepta un entero o un texto no vacío (`7` o `"tecnico-1"`).
export function IsIntOrNonEmptyString(
  options?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isIntOrNonEmptyString',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be an integer or a non-empty string`,
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          Number.isInteger(value) ||
          (typeof value === 'string' && value.trim().length > 0),
      },
    });
  };
}
