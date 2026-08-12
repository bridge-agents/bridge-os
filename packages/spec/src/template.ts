import { z } from "zod";
import { SlugSchema } from "./common.js";
import { ManifestSchema } from "./manifest.js";

/**
 * Templates are data, never code: a complete, valid Manifest plus catalog
 * metadata. Instantiating a template = clone manifest, adjust meta, then run
 * user customisations through the same validation pipeline as everything else.
 */
export const TemplateSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum([
    "personal",
    "business",
    "development",
    "research",
    "education",
    "fitness",
    "custom",
  ]),
  manifest: ManifestSchema,
});
export type Template = z.infer<typeof TemplateSchema>;
