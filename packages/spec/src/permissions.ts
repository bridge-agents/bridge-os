import { z } from "zod";

export const PermissionEffectSchema = z.enum(["allow", "deny", "ask"]);
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

/**
 * A rule scoped to a resource ("tool:gmail", or prefix glob "tool:gmail*")
 * and a set of actions ("read", "send", ... or "*").
 */
export const PermissionRuleSchema = z.object({
  resource: z.string().min(1),
  actions: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]).default("*"),
  effect: PermissionEffectSchema,
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const PermissionPolicySchema = z.object({
  /** Effect when no rule matches. Bridge defaults to "ask": nothing is silently allowed. */
  default: PermissionEffectSchema.default("ask"),
  /** Ordered rules; first match wins. */
  rules: z.array(PermissionRuleSchema).default([]),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

function matchesResource(pattern: string, resource: string): boolean {
  if (pattern.endsWith("*")) return resource.startsWith(pattern.slice(0, -1));
  return pattern === resource;
}

/**
 * Deterministic policy evaluation: ordered rules, first match wins,
 * fall through to the policy default. Every tool call in the runtime
 * must pass through this function.
 */
export function evaluatePermission(
  policy: PermissionPolicy,
  resource: string,
  action: string,
): PermissionEffect {
  for (const rule of policy.rules) {
    if (!matchesResource(rule.resource, resource)) continue;
    if (rule.actions !== "*" && !rule.actions.includes(action)) continue;
    return rule.effect;
  }
  return policy.default;
}
