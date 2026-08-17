import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { BridgeError, id } from "@bridge/core";
import { attachments } from "@bridge/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth, requireWorkspace } from "./auth.js";
import type { AppDeps, AppEnv } from "./http.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Workspace-scoped upload and download routes. */
export function attachmentRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.post("/", async (c) => {
    const form = await c.req.formData().catch(() => {
      throw new BridgeError("validation_failed", "request must be multipart form data");
    });
    const upload = form.get("file");
    if (!(upload instanceof File)) {
      throw new BridgeError("validation_failed", "file is required");
    }
    if (upload.size === 0) throw new BridgeError("validation_failed", "file is empty");
    if (upload.size > MAX_ATTACHMENT_BYTES) {
      throw new BridgeError("validation_failed", "files must be 25 MB or smaller");
    }

    const workspaceId = c.get("workspaceId");
    const attachmentId = id("att");
    const name = safeFilename(upload.name);
    const mimeType = upload.type || mimeFromName(name);
    const directory = resolve(deps.dataDir ?? "./.bridge", "uploads", workspaceId);
    const storagePath = join(directory, attachmentId);
    await mkdir(directory, { recursive: true });
    await writeFile(storagePath, Buffer.from(await upload.arrayBuffer()), { flag: "wx" });

    const [saved] = await deps.db
      .insert(attachments)
      .values({
        id: attachmentId,
        workspaceId,
        name,
        mimeType,
        sizeBytes: upload.size,
        storagePath,
      })
      .returning({
        id: attachments.id,
        name: attachments.name,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        createdAt: attachments.createdAt,
      });

    return c.json({ attachment: saved }, 201);
  });

  app.get("/:attachmentId", async (c) => {
    const [attachment] = await deps.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.workspaceId, c.get("workspaceId")),
          eq(attachments.id, c.req.param("attachmentId")),
        ),
      );
    if (!attachment) throw new BridgeError("not_found", "attachment not found");

    const data = await readFile(attachment.storagePath).catch(() => {
      throw new BridgeError("not_found", "attachment data is unavailable");
    });
    return new Response(data, {
      headers: {
        "content-type": attachment.mimeType,
        "content-length": String(attachment.sizeBytes),
        "content-disposition": `${attachment.mimeType.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.delete("/:attachmentId", async (c) => {
    const [attachment] = await deps.db
      .delete(attachments)
      .where(
        and(
          eq(attachments.workspaceId, c.get("workspaceId")),
          eq(attachments.id, c.req.param("attachmentId")),
          isNull(attachments.runId),
        ),
      )
      .returning({ storagePath: attachments.storagePath });
    if (!attachment) throw new BridgeError("not_found", "unattached file not found");
    await unlink(attachment.storagePath).catch(() => undefined);
    return c.body(null, 204);
  });

  return app;
}

function safeFilename(value: string): string {
  const cleaned = Array.from(value, (character) =>
    character.charCodeAt(0) < 32 || character === "/" || character === "\\" ? "_" : character,
  )
    .join("")
    .trim()
    .slice(0, 240);
  return cleaned || "attachment";
}

function mimeFromName(name: string): string {
  const extension = extname(name).toLowerCase();
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    }[extension] ?? "application/octet-stream"
  );
}
