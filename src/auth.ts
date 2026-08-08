import {
  hasStrongSecret,
  MIN_SECRET_LENGTH,
  type WorkerSettings
} from "./config";

const encoder = new TextEncoder();

export type AuthSuccess = { ok: true };
export type AuthFailure = { ok: false; status: 401 | 503; message: string };
export type AuthResult = AuthSuccess | AuthFailure;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = leftDigest.length ^ rightDigest.length;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index]! ^ rightDigest[index]!;
  }
  return difference === 0;
}

function suppliedToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  return authorization?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || undefined;
}

export async function authenticate(request: Request, env: WorkerSettings): Promise<AuthResult> {
  const configured = env.MCP_API_TOKEN?.trim();
  if (!hasStrongSecret(configured)) {
    return {
      ok: false,
      status: 503,
      message: `MCP_API_TOKEN must contain at least ${MIN_SECRET_LENGTH} characters.`
    };
  }

  const supplied = suppliedToken(request);
  if (!supplied || !(await constantTimeEqual(supplied, configured))) {
    return { ok: false, status: 401, message: "Missing or invalid MCP bearer token." };
  }

  return { ok: true };
}
