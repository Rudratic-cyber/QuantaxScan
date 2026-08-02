import { Link } from "wouter";
import { QuantaXscanLogo } from "@/components/QuantaXscanLogo";

const COLUMNS: { title: string; links: { label: string; href: string; external?: boolean; planned?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Scanner", href: "/scan" },
      { label: "Coverage", href: "/coverage" },
      { label: "Dashboard", href: "/dashboard" },
      { label: "Demo repos", href: "/demo/paramiko-ssh" },
    ],
  },
  {
    title: "Trust",
    links: [
      { label: "Security posture", href: "/security" },
      { label: "Standards & citations", href: "/coverage" },
      { label: "Community", href: "/community" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Discord", href: "https://discord.gg/qReVaR2TpC", external: true },
      { label: "Docs", href: "#", planned: true },
      { label: "Blog", href: "#", planned: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-[#e5e7eb] bg-[#f7f8fa]">
      <div className="container mx-auto px-4 py-14">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
          <div className="col-span-2">
            <QuantaXscanLogo variant="full" size="sm" />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-[#6b7280]">
              The cryptographic inventory of record for post-quantum readiness. Find where your
              crypto lives before the deadlines land.
            </p>
            <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-3 py-1 text-[11px] font-medium text-[#6b7280]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#d97706]" />
              Pre-launch — surfaces marked Planned are not yet built
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[#9aa3b2]">{col.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.external ? (
                      <a href={l.href} target="_blank" rel="noopener noreferrer"
                         className="text-sm text-[#475569] transition-colors hover:text-[#0a0e1a]">
                        {l.label}
                      </a>
                    ) : l.planned ? (
                      <span className="inline-flex items-center gap-1.5 text-sm text-[#6b7280]">
                        {l.label}
                        <span className="rounded border border-[#e5e7eb] bg-[#f1f3f7] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#6b7280]">Planned</span>
                      </span>
                    ) : (
                      <Link href={l.href} className="text-sm text-[#475569] transition-colors hover:text-[#0a0e1a]">
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-[#e5e7eb] pt-6 text-xs text-[#9aa3b2] sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} QuantaXscan. Built to survive an audit.</span>
          <span className="flex items-center gap-4">
            <span>NIST FIPS 203 · 204 · 205</span>
            <span>CycloneDX CBOM</span>
          </span>
        </div>
      </div>
    </footer>
  );
}
