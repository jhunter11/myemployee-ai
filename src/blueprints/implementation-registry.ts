import { z } from 'zod';

import { BlueprintDigestSchema } from './contracts';

const BlueprintImplementationRegistrationSchema = z.strictObject({
  implementationId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
  digest: BlueprintDigestSchema
});

export interface BlueprintImplementationRegistration {
  implementationId: string;
  digest: string;
}

/**
 * A construction-only registry of deployment-owned implementations. Blueprint
 * input can resolve one of these digests but has no API for registering code.
 */
export class BlueprintImplementationRegistry {
  private readonly byDigest = new Map<string, Readonly<BlueprintImplementationRegistration>>();

  constructor(registrations: readonly BlueprintImplementationRegistration[]) {
    const implementationIds = new Set<string>();
    for (const rawRegistration of registrations) {
      const registration = BlueprintImplementationRegistrationSchema.parse(rawRegistration);
      if (this.byDigest.has(registration.digest)) {
        throw new Error(`Implementation digest ${registration.digest} is already registered`);
      }
      if (implementationIds.has(registration.implementationId)) {
        throw new Error(`Implementation ${registration.implementationId} is already registered`);
      }
      implementationIds.add(registration.implementationId);
      this.byDigest.set(registration.digest, Object.freeze({ ...registration }));
    }
  }

  resolve(digest: string): Readonly<BlueprintImplementationRegistration> {
    const validDigest = BlueprintDigestSchema.parse(digest);
    const implementation = this.byDigest.get(validDigest);
    if (implementation === undefined) {
      throw new Error(`Implementation digest ${validDigest} is not statically registered`);
    }
    return implementation;
  }
}
