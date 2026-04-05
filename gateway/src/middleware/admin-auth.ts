import { createHmac } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { GatewayConfig } from "../types.js";

const COOKIE_NAME = "clawx_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function sign(username: string, expiry: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${username}:${expiry}`)
    .digest("hex");
}

export function issueSessionCookie(username: string, secret: string): string {
  const expiry = Date.now() + SESSION_TTL_MS;
  const token = `${username}.${expiry}.${sign(username, expiry, secret)}`;
  const maxAge = SESSION_TTL_MS / 1000;
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/admin; Max-Age=${maxAge}; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/admin; Max-Age=0; SameSite=Strict`;
}

function verifySessionCookie(cookieHeader: string | undefined, secret: string): boolean {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const parts = match[1].split(".");
  if (parts.length !== 3) return false;
  const [username, expiryStr, mac] = parts;
  const expiry = Number(expiryStr);
  if (isNaN(expiry) || Date.now() > expiry) return false;
  return mac === sign(username, expiry, secret);
}

export function createAdminAuthHook(config: GatewayConfig) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.url.startsWith("/admin/")) return;
    // Login/logout pages handle their own auth
    if (req.url === "/admin/login" || req.url.startsWith("/admin/login?")) return;
    if (req.url === "/admin/logout") return;

    const secret = config.adminAuth?.password ?? "changeme";
    if (!verifySessionCookie(req.headers.cookie, secret)) {
      reply.redirect(`/admin/login?next=${encodeURIComponent(req.url)}`);
    }
  };
}
