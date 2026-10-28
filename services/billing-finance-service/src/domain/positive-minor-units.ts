import { BadRequestException } from '@nestjs/common';

export function positiveMinorUnits(value: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) throw new BadRequestException('Amount must be strictly positive');
  const amount = BigInt(value);
  if (amount <= 0n) throw new BadRequestException('Amount must be strictly positive');
  return amount;
}
