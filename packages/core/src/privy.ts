import { type CryptoKey, type JWTPayload, errors, importSPKI, jwtVerify } from "jose";

// Privy access tokens are ES256 JWTs: iss "privy.io", aud = our app id,
// sub = the user's Privy DID. The verification key is the PEM from the Privy
// dashboard. https://docs.privy.io/authentication/user-authentication/access-tokens

export class PrivyAuthError extends Error {
  constructor(readonly reason: "INVALID" | "EXPIRED") {
    super(`privy token rejected: ${reason}`);
    this.name = "PrivyAuthError";
  }
}

export type PrivyVerifier = (token: string) => Promise<{ did: string; payload: JWTPayload }>;

export async function createPrivyVerifier(opts: {
  appId: string;
  verificationKeyPem: string;
  clockToleranceSeconds?: number;
}): Promise<PrivyVerifier> {
  const key: CryptoKey = await importSPKI(opts.verificationKeyPem, "ES256");
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: "privy.io",
        audience: opts.appId,
        algorithms: ["ES256"], // pinned: no alg confusion, no "none"
        clockTolerance: opts.clockToleranceSeconds ?? 30,
      });
      if (typeof payload.sub !== "string" || !payload.sub.startsWith("did:privy:")) {
        throw new PrivyAuthError("INVALID");
      }
      return { did: payload.sub, payload };
    } catch (e) {
      if (e instanceof PrivyAuthError) throw e;
      if (e instanceof errors.JWTExpired) throw new PrivyAuthError("EXPIRED");
      throw new PrivyAuthError("INVALID");
    }
  };
}
