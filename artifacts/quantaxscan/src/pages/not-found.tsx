import { Shield } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 bg-white text-[#0a0e1a] text-center">
      <Shield className="h-24 w-24 text-[#4f46e5] mb-6 opacity-90" />
      <h1 className="text-6xl font-bold font-mono mb-2 tracking-tighter text-[#0a0e1a]">404</h1>
      <h2 className="text-2xl font-semibold mb-6">Page not found</h2>
      <p className="text-[#6b7280] mb-8 max-w-md">
        The page you are looking for does not exist. It may have been moved or
        removed, or the link you followed may be out of date.
      </p>
      <Link href="/">
        <Button className="bg-[#4f46e5] hover:bg-[#4338ca] text-white">
          Back to home
        </Button>
      </Link>
    </div>
  );
}
