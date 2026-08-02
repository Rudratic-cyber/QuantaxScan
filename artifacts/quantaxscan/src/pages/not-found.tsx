import { Shield } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 bg-bg-primary text-text-primary text-center">
      <Shield className="h-24 w-24 text-critical mb-6 opacity-80" />
      <h1 className="text-6xl font-bold font-mono mb-2 tracking-tighter text-critical">404</h1>
      <h2 className="text-2xl font-semibold mb-6">Sector Not Found</h2>
      <p className="text-text-muted mb-8 max-w-md">
        The coordinate you are attempting to access does not exist in our threat database. 
        It may have been purged or relocated during a system recalibration.
      </p>
      <Link href="/">
        <Button className="bg-accent-primary hover:bg-accent-primary/90 text-white">
          Return to Command Center
        </Button>
      </Link>
    </div>
  );
}
