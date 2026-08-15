import { useState } from "react";
import {
  useListDivisions,
  useCreateDivision,
  useDeleteDivision,
  useListOrganizationMembers,
  useUpdateOrganizationMemberRole,
  useGrantDivisionRole,
  useRevokeDivisionGrant,
} from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { AlertTriangle, Building2, Lock, ShieldCheck, Trash2, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * RBAC's management surface. docs/Claude/15-rbac-design.md §5.
 *
 * Two things on this page carry the whole design, and both are wording
 * decisions rather than layout ones:
 *
 *  1. **A role says what somebody may do, not what they are.** Every role is
 *     rendered with the sentence that describes its power, because "viewer"
 *     means nothing to the person choosing it and "reads everything, changes
 *     nothing" means exactly the right thing.
 *  2. **Dissolving a division does not delete its projects.** They become
 *     organisation-wide — visible to the whole tenant. That is a *widening* of
 *     access disguised as a tidy-up, so the confirmation says so in those
 *     words rather than asking "are you sure?".
 *
 * The page is admin-only at the API, and it does not pretend otherwise: a
 * non-admin who reaches it sees the refusal the server gave, not an empty
 * table that looks like an organisation with no members.
 */

const ROLE_MEANING: Record<string, string> = {
  viewer: "Reads everything in scope. Changes nothing.",
  member: "Creates projects and submits collections. No credentials.",
  admin: "Manages members, credentials and divisions.",
  owner: "Everything an admin can do, plus transferring or deleting the organisation.",
};

const ROLE_ORDER = ["viewer", "member", "admin", "owner"] as const;

const inputClass =
  "w-full rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] px-4 py-2.5 text-sm text-[#0a0e1a] placeholder-[#9aa3b2] focus:outline-none focus:border-[#4f46e5] transition-colors";
const labelClass = "block text-xs font-semibold text-[#0a0e1a] mb-1.5";

function RoleBadge({ role }: { role: string }) {
  const strong = role === "admin" || role === "owner";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={
        strong
          ? { color: "#4338ca", backgroundColor: "#eef2ff" }
          : { color: "#4b5563", backgroundColor: "#f3f4f6" }
      }
      data-testid="role-badge"
      data-role={role}
      title={ROLE_MEANING[role] ?? role}
    >
      {strong && <ShieldCheck className="h-3 w-3" />}
      {role}
    </span>
  );
}

/** A refusal the server actually gave, rendered as itself. */
function Refused({ what }: { what: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-[#fde68a] bg-[#fffbeb] p-4"
      data-testid="access-refused"
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" />
      <div>
        <p className="text-xs font-semibold text-[#0a0e1a]">{what} needs the admin role.</p>
        <p className="mt-1 text-[11px] leading-relaxed text-[#6b7280]">
          You are signed in, and this is not a missing page — it is one your role does not reach. An
          administrator can change that.
        </p>
      </div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6" style={{ boxShadow: "0 8px 24px rgba(15,23,42,0.06)" }}>
      {children}
    </div>
  );
}

export function Access() {
  const divisions = useListDivisions();
  const members = useListOrganizationMembers();
  const createDivision = useCreateDivision();
  const deleteDivision = useDeleteDivision();
  const updateRole = useUpdateOrganizationMemberRole();
  const grantRole = useGrantDivisionRole();
  const revokeGrant = useRevokeDivisionGrant();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [formError, setFormError] = useState("");
  const [grantFor, setGrantFor] = useState<{ divisionId: number; userId: string; role: string }>({
    divisionId: 0,
    userId: "",
    role: "viewer",
  });

  // 403 is a real, expected answer here rather than an error state — this page
  // is admin-only and a member reaching it should be told why, not shown a
  // spinner or an empty organisation.
  const membersForbidden = members.isError && (members.error as { status?: number } | null)?.status === 403;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("A division needs a name.");
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      setFormError("The handle must be lower-case letters, digits and single hyphens — it appears in URLs.");
      return;
    }
    setFormError("");

    createDivision.mutate(
      { data: { name: name.trim(), slug } },
      {
        onSuccess: () => {
          setName("");
          setSlug("");
          void divisions.refetch();
          toast({ title: "Division created" });
        },
        onError: (err) => {
          const status = (err as { status?: number }).status;
          setFormError(
            status === 409
              ? `A division with the handle "${slug}" already exists.`
              : status === 403
                ? "Creating a division needs the admin role."
                : "Could not create the division.",
          );
        },
      },
    );
  };

  const handleDissolve = (id: number, divisionName: string, projects: number) => {
    // Names the consequence rather than asking "are you sure?". Dissolving a
    // division widens who can see its work, and that is the thing worth
    // pausing over — not the deletion itself.
    const consequence =
      projects === 0
        ? `Dissolve "${divisionName}"? It holds no projects.`
        : `Dissolve "${divisionName}"? Its ${projects} project${projects === 1 ? "" : "s"} will not be deleted — ` +
          `${projects === 1 ? "it becomes" : "they become"} visible to everyone in the organisation.`;
    if (!window.confirm(consequence)) return;

    deleteDivision.mutate(
      { id },
      {
        onSuccess: (result) => {
          void divisions.refetch();
          toast({
            title: "Division dissolved",
            description:
              (result as { projectsReleased: number }).projectsReleased > 0
                ? `${(result as { projectsReleased: number }).projectsReleased} project(s) are now organisation-wide.`
                : undefined,
          });
        },
        onError: () => toast({ title: "Could not dissolve the division", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="min-h-screen bg-[#f7f8fa] px-6 py-10">
      <div className="mx-auto max-w-5xl">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-2xl font-bold tracking-tight text-[#0a0e1a]">Access</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-[#6b7280]">
            Who is in this organisation, what each of them may do, and which divisions their access
            is scoped to. A division grant only ever <span className="font-semibold">raises</span> a
            person's role — it never lowers what the organisation already gave them.
          </p>
        </motion.div>

        {/* ── Members ── */}
        <div className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-[#4f46e5]" />
            <h2 className="text-sm font-bold text-[#0a0e1a]">Members</h2>
          </div>

          <Panel>
            {membersForbidden ? (
              <Refused what="Seeing who is in this organisation" />
            ) : members.isPending ? (
              <p className="py-6 text-center font-mono text-xs text-[#9aa3b2]">Loading members…</p>
            ) : members.isError ? (
              <p className="py-6 text-center text-xs text-[#dc2626]">Members could not be read.</p>
            ) : members.data.members.length === 0 ? (
              <p className="py-6 text-center text-xs text-[#6b7280]">
                No members yet. People appear here once they sign in.
              </p>
            ) : (
              <table className="w-full text-sm" data-testid="members-table">
                <thead>
                  <tr className="border-b border-[#e5e7eb] text-left">
                    <th className="pb-2 text-[10px] font-mono uppercase tracking-wider text-[#9aa3b2]">Person</th>
                    <th className="pb-2 text-[10px] font-mono uppercase tracking-wider text-[#9aa3b2]">Role</th>
                    <th className="pb-2 text-[10px] font-mono uppercase tracking-wider text-[#9aa3b2]">
                      Division grants
                    </th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {members.data.members.map((member) => (
                    <tr key={member.userId} className="border-b border-[#f1f3f7]" data-testid="member-row">
                      <td className="py-3 font-mono text-xs text-[#0a0e1a]">{member.userId}</td>
                      <td className="py-3">
                        <RoleBadge role={member.role} />
                        <p className="mt-1 text-[10px] leading-relaxed text-[#6b7280]">
                          {ROLE_MEANING[member.role]}
                        </p>
                      </td>
                      <td className="py-3">
                        {member.divisionGrants.length === 0 ? (
                          <span className="text-[11px] text-[#9aa3b2]">Organisation-wide</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {member.divisionGrants.map((grant) => (
                              <span
                                key={grant.divisionId}
                                className="inline-flex items-center gap-1 rounded-full border border-[#e5e7eb] px-2 py-0.5 text-[10px] text-[#4b5563]"
                              >
                                {divisions.data?.divisions.find((d) => d.id === grant.divisionId)?.name ??
                                  `#${grant.divisionId}`}
                                : {grant.role}
                                <button
                                  type="button"
                                  aria-label="Revoke grant"
                                  className="ml-0.5 text-[#9aa3b2] hover:text-[#dc2626]"
                                  onClick={() =>
                                    revokeGrant.mutate(
                                      { id: grant.divisionId, userId: member.userId },
                                      {
                                        onSuccess: () => {
                                          void members.refetch();
                                          toast({ title: "Grant revoked" });
                                        },
                                      },
                                    )
                                  }
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <select
                          className="rounded-lg border border-[#e5e7eb] bg-white px-2 py-1 text-xs"
                          aria-label={`Role for ${member.userId}`}
                          value={member.role}
                          onChange={(e) =>
                            updateRole.mutate(
                              { userId: member.userId, data: { role: e.target.value as never } },
                              {
                                onSuccess: () => {
                                  void members.refetch();
                                  toast({ title: "Role updated" });
                                },
                                onError: (err) =>
                                  toast({
                                    // The one refusal worth quoting: an
                                    // organisation with no owner has nobody who
                                    // can transfer or delete it.
                                    title:
                                      (err as { status?: number }).status === 409
                                        ? "That would leave the organisation with no owner"
                                        : "Could not change the role",
                                    variant: "destructive",
                                  }),
                              },
                            )
                          }
                        >
                          {ROLE_ORDER.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        {/* ── Divisions ── */}
        <div className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-[#4f46e5]" />
            <h2 className="text-sm font-bold text-[#0a0e1a]">Divisions</h2>
          </div>

          <Panel>
            <form onSubmit={handleCreate} className="mb-6 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <div>
                <label className={labelClass} htmlFor="division-name">
                  Name
                </label>
                <input
                  id="division-name"
                  className={inputClass}
                  placeholder="Payments"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="division-slug">
                  Handle
                </label>
                <input
                  id="division-slug"
                  className={inputClass}
                  placeholder="payments"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  className="rounded-xl bg-[#4f46e5] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#4338ca] disabled:opacity-50"
                  disabled={createDivision.isPending}
                >
                  Create
                </button>
              </div>
              {formError && (
                <p className="sm:col-span-3 text-xs text-[#dc2626]" data-testid="division-form-error">
                  {formError}
                </p>
              )}
              <p className="sm:col-span-3 text-[10px] leading-relaxed text-[#9aa3b2]">
                The handle appears in URLs and cannot be changed afterwards. Projects left in no
                division stay visible to everyone in the organisation.
              </p>
            </form>

            {divisions.isPending ? (
              <p className="py-6 text-center font-mono text-xs text-[#9aa3b2]">Loading divisions…</p>
            ) : divisions.isError ? (
              <p className="py-6 text-center text-xs text-[#dc2626]">Divisions could not be read.</p>
            ) : divisions.data.divisions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#e5e7eb] p-6 text-center" data-testid="no-divisions">
                <p className="text-xs font-semibold text-[#0a0e1a]">No divisions yet.</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#6b7280]">
                  Every project is organisation-wide, visible to everyone in the tenant. Create a
                  division to scope access to a team or business unit.
                </p>
              </div>
            ) : (
              <div className="space-y-2" data-testid="divisions-list">
                {divisions.data.divisions.map((division) => (
                  <div
                    key={division.id}
                    className="flex items-center justify-between rounded-xl border border-[#e5e7eb] p-3"
                    data-testid="division-row"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#0a0e1a]">{division.name}</p>
                      <p className="font-mono text-[10px] text-[#9aa3b2]">
                        {division.slug} · {division.projects ?? 0} project
                        {(division.projects ?? 0) === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-[#e5e7eb] px-2.5 py-1 text-[11px] font-medium text-[#4b5563] hover:border-[#4f46e5]"
                        onClick={() => setGrantFor({ divisionId: division.id, userId: "", role: "viewer" })}
                      >
                        Grant access
                      </button>
                      <button
                        type="button"
                        aria-label={`Dissolve ${division.name}`}
                        className="rounded-lg border border-[#e5e7eb] p-1.5 text-[#9aa3b2] hover:border-[#dc2626] hover:text-[#dc2626]"
                        onClick={() => handleDissolve(division.id, division.name, division.projects ?? 0)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {grantFor.divisionId !== 0 && (
              <div className="mt-4 rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] p-4" data-testid="grant-form">
                <p className="mb-3 text-xs font-semibold text-[#0a0e1a]">
                  Grant access to{" "}
                  {divisions.data?.divisions.find((d) => d.id === grantFor.divisionId)?.name ?? "this division"}
                </p>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                  <input
                    className={inputClass}
                    placeholder="User ID"
                    aria-label="User ID"
                    value={grantFor.userId}
                    onChange={(e) => setGrantFor((g) => ({ ...g, userId: e.target.value }))}
                  />
                  <select
                    className="rounded-xl border border-[#e5e7eb] bg-white px-3 text-sm"
                    aria-label="Grant role"
                    value={grantFor.role}
                    onChange={(e) => setGrantFor((g) => ({ ...g, role: e.target.value }))}
                  >
                    {/* No `owner`: ownership is a fact about the organisation. */}
                    {["viewer", "member", "admin"].map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded-xl bg-[#4f46e5] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#4338ca]"
                    onClick={() =>
                      grantRole.mutate(
                        {
                          id: grantFor.divisionId,
                          data: { userId: grantFor.userId.trim(), role: grantFor.role as never },
                        },
                        {
                          onSuccess: () => {
                            setGrantFor({ divisionId: 0, userId: "", role: "viewer" });
                            void members.refetch();
                            toast({ title: "Access granted" });
                          },
                          onError: (err) =>
                            toast({
                              title:
                                (err as { status?: number }).status === 404
                                  ? "That person is not a member of this organisation"
                                  : "Could not grant access",
                              variant: "destructive",
                            }),
                        },
                      )
                    }
                  >
                    Grant
                  </button>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-[#9aa3b2]">
                  A grant raises what this person may do inside the division. It cannot lower what
                  the organisation already gave them.
                </p>
              </div>
            )}
          </Panel>
        </div>

        <div className="mt-6 flex items-start gap-2 rounded-xl border border-[#eceef2] bg-white p-4">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#9aa3b2]" />
          <p className="text-[10px] leading-relaxed text-[#6b7280]">
            Moving a project between divisions takes effect for existing findings on the next
            collection — an asset records the division it was collected under.
          </p>
        </div>
      </div>
    </div>
  );
}
