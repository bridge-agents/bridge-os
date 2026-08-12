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

export interface PermissionDecision {
  effect: PermissionEffect;
  /** False when no rule matched and the policy default was used. */
  matched: boolean;
}

/**
 * Deterministic policy evaluation: ordered rules, first match wins,
 * fall through to the policy default. Every tool call in the runtime
 * must pass through this function.
 *
 * `matched` matters because a dangerous action should never be allowed by a
 * blanket default — only by a rule someone wrote on purpose.
 */
export function decidePermission(
  policy: PermissionPolicy,
  resource: string,
  action: string,
): PermissionDecision {
  for (const rule of policy.rules) {
    if (!matchesResource(rule.resource, resource)) continue;
    if (rule.actions !== "*" && !rule.actions.includes(action)) continue;
    return { effect: rule.effect, matched: true };
  }
  return { effect: policy.default, matched: false };
}

export function evaluatePermission(
  policy: PermissionPolicy,
  resource: string,
  action: string,
): PermissionEffect {
  return decidePermission(policy, resource, action).effect;
}

/**
 * The decision the runtime actually enforces. A destructive action that is
 * only permitted by the policy default is downgraded to `ask`: allowing it
 * has to be deliberate, not a side effect of a permissive default.
 */
export function decideToolPermission(
  policy: PermissionPolicy,
  toolName: string,
  action: string,
  isDangerous: boolean,
): PermissionEffect {
  const { effect, matched } = decidePermission(policy, `tool:${toolName}`, action);
  if (isDangerous && !matched && effect === "allow") return "ask";
  return effect;
}
