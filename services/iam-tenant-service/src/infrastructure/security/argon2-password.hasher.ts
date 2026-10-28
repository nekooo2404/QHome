import argon2 from 'argon2';
import { PasswordHasher } from '../../application/ports';

export class Argon2idPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 2,
    });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password, { type: argon2.argon2id });
    } catch {
      return false;
    }
  }
}
