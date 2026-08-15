import { describe, it, expect } from "vitest";
import {
  DIVISION_ROLE_VALUES,
  ORG_ROLE_VALUES,
  roleAtLeast,
  strongerRole,
} from "./schema/auth-enums";

/**
 * RBAC's ordering, which is load-bearing in a way a tuple usually is not:
 * `roleAtLeast` compares by index, so the order of `ORG_ROLE_VALUES` decides
 * what every grant in the product permits. These assertions exist so that
 * reordering it fails loudly here rather than quietly widening access.
 *
 * docs/Claude/15-rbac-design.md §3.
 */
describe("the role ordering", () => {
  it("runs weakest to strongest, and that order is the permission model", () => {
    expect(ORG_ROLE_VALUES).toEqual(["viewer", "member", "admin", "owner"]);
    // A division cannot have an owner: ownership is a fact about the tenant,
    // and a "division owner" would imply a right to delete something they do
    // not own.
    expect(DIVISION_ROLE_VALUES).toEqual(["viewer", "member", "admin"]);
    for (const role of DIVISION_ROLE_VALUES) expect(ORG_ROLE_VALUES).toContain(role);
  });

  it("answers the one question every gate asks", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });

  it("treats a role it does not recognise as permitting nothing", () => {
    // The safe reading of "I do not know what this is" is "not permitted".
    // A build that meets a role from a newer deployment must not fail open.
    expect(roleAtLeast("superuser", "viewer")).toBe(false);
    expect(roleAtLeast("", "viewer")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
  });

  it("combines an org role with a division grant by taking the stronger", () => {
    // The rule from §2: a grant raises, never lowers.
    expect(strongerRole("member", "admin")).toBe("admin");
    expect(strongerRole("admin", "viewer")).toBe("admin");
    expect(strongerRole("viewer", "member")).toBe("member");
    expect(strongerRole("owner", "admin")).toBe("owner");
  });

  it("is null only when neither side names a role at all", () => {
    expect(strongerRole(null, null)).toBeNull();
    expect(strongerRole(null, "viewer")).toBe("viewer");
    expect(strongerRole("viewer", null)).toBe("viewer");
    // An unrecognised value is not a role, so it cannot raise anything.
    expect(strongerRole("wizard", null)).toBeNull();
    expect(strongerRole("wizard", "member")).toBe("member");
  });

  it("keeps the two roles the product shipped with meaningful", () => {
    // `owner` and `member` predate this widening and exist in real rows. Both
    // must still be members of the tuple or the CHECK constraint would reject
    // data that is already stored.
    expect(ORG_ROLE_VALUES).toContain("owner");
    expect(ORG_ROLE_VALUES).toContain("member");
    // ...and the widening has to have actually changed the answer, or it was
    // only a label: a member is no longer implicitly an administrator.
    expect(roleAtLeast("member", "admin")).toBe(false);
  });
});
