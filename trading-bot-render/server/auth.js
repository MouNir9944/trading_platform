import crypto from "node:crypto";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest();

/**
 * HTTP Basic auth for the whole app. The dashboard can place real orders, so a publicly
 * reachable deployment must never be open. /healthz stays public for Render's health check.
 */
export function basicAuth({ username, password }) {
  const expectedUser = sha256(username);
  const expectedPass = sha256(password);

  return (req, res, next) => {
    if (req.path === "/healthz") return next();

    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
      const split = decoded.indexOf(":");
      if (split >= 0) {
        const userOk = crypto.timingSafeEqual(sha256(decoded.slice(0, split)), expectedUser);
        const passOk = crypto.timingSafeEqual(sha256(decoded.slice(split + 1)), expectedPass);
        if (userOk && passOk) return next();
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Trading dashboard", charset="UTF-8"');
    res.status(401).json({ detail: "Authentication required" });
  };
}
