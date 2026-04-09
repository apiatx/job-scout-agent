import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, DollarSign, MapPin, Briefcase, Filter, User, Loader2, Check, AlertCircle } from "lucide-react";

type WorkType = "any" | "remote" | "office" | "hybrid";

const DEFAULT_CRITERIA: CriteriaData = {
  min_salary: 130000,
  work_type: "any",
  locations: [
    "Remote", "United States", "South Carolina", "North Carolina",
    "Georgia", "Florida", "South East", "South",
  ],
  target_roles: [
    "Enterprise Account Executive", "Strategic Account Executive",
    "Senior Account Executive", "Regional Sales Manager",
    "Named Account Executive", "sales account executive",
    "sales executive", "senior sales executive", "sr. sales executive",
    "mid market account executive", "mid-market account executive",
    "account manager", "Enterprise account manager",
    "senior account manager", "sr. account manager",
    "strategic account manager",
  ],
  industries: [
    "AI Infrastructure", "Data Center Hardware", "Semiconductors",
    "Networking Hardware", "Storage Hardware", "Optical Networking",
    "Edge Computing", "Power & Cooling Infrastructure", "Server Hardware",
    "Industrial Automation", "Oilfield Services Technology",
    "Energy Technology", "Clean Energy / Energy Storage", "Machine Vision",
    "Test and Measurement", "Materials Science / Specialty Chemicals",
    "Robotics", "Servers", "HPC", "Compute",
  ],
  must_have: [
    "enterprise sales",
    "hardware OR infrastructure OR networking OR storage OR semiconductor OR compute OR optical",
  ],
  nice_to_have: [
    "AI", "data center", "GPU", "NVIDIA", "industrial automation",
    "energy technology", "machine vision", "robotics",
    "oilfield services", "energy storage", "industrial AI",
    "oil and gas software", "utility software", "grid technology",
    "clean energy",
  ],
  avoid: [
    "SDR", "BDR", "inbound only", "SMB only", "pure SaaS",
    "marketing", "recruiting",
  ],
  your_name: "",
  your_email: "",
};

interface CriteriaData {
  min_salary: number | null;
  work_type: WorkType;
  locations: string[];
  target_roles: string[];
  industries: string[];
  must_have: string[];
  nice_to_have: string[];
  avoid: string[];
  your_name: string;
  your_email: string;
}

function TagInput({
  label,
  description,
  tags,
  onAdd,
  onRemove,
  placeholder,
  accentColor = "default",
}: {
  label: string;
  description?: string;
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (index: number) => void;
  placeholder?: string;
  accentColor?: "default" | "green" | "amber" | "red";
}) {
  const [value, setValue] = useState("");

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && value.trim()) {
      e.preventDefault();
      onAdd(value.trim());
      setValue("");
    }
  };

  const badgeClasses = {
    default: "bg-secondary/80 text-secondary-foreground hover:bg-secondary border border-border/40",
    green: "bg-emerald-50 text-emerald-700 border border-emerald-200/60 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800/40",
    amber: "bg-amber-50 text-amber-700 border border-amber-200/60 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800/40",
    red: "bg-red-50 text-red-700 border border-red-200/60 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800/40",
  };

  return (
    <div className="space-y-2.5">
      <div>
        <Label className="text-sm font-semibold">{label}</Label>
        {description && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag, i) => (
            <Badge key={i} variant="secondary" className={`gap-1 pr-1 text-xs font-medium transition-all duration-150 ${badgeClasses[accentColor]}`}>
              {tag}
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? `Add ${label.toLowerCase()} and press Enter`}
        className="bg-background/50 transition-all duration-200 focus:ring-2 focus:ring-primary/20"
      />
    </div>
  );
}

function SectionIcon({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 text-primary shrink-0 ${className}`}>
      {children}
    </div>
  );
}

export default function SearchCriteria() {
  const [criteria, setCriteria] = useState<CriteriaData>({
    min_salary: null,
    work_type: "any",
    locations: [],
    target_roles: [],
    industries: [],
    must_have: [],
    nice_to_have: [],
    avoid: [],
    your_name: "",
    your_email: "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/criteria")
      .then((r) => r.json())
      .then((data) => {
        if (data && data.id) {
          setCriteria({
            min_salary: data.min_salary ?? DEFAULT_CRITERIA.min_salary,
            work_type: data.work_type ?? DEFAULT_CRITERIA.work_type,
            locations: data.locations?.length ? data.locations : DEFAULT_CRITERIA.locations,
            target_roles: data.target_roles?.length ? data.target_roles : DEFAULT_CRITERIA.target_roles,
            industries: data.industries?.length ? data.industries : DEFAULT_CRITERIA.industries,
            must_have: data.must_have?.length ? data.must_have : DEFAULT_CRITERIA.must_have,
            nice_to_have: data.nice_to_have?.length ? data.nice_to_have : DEFAULT_CRITERIA.nice_to_have,
            avoid: data.avoid?.length ? data.avoid : DEFAULT_CRITERIA.avoid,
            your_name: data.your_name ?? "",
            your_email: data.your_email ?? "",
          });
        } else {
          setCriteria(DEFAULT_CRITERIA);
        }
      })
      .catch(() => {
        setCriteria(DEFAULT_CRITERIA);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setSaveError(false);
    try {
      const resp = await fetch("/api/criteria", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(criteria),
      });
      if (!resp.ok) throw new Error('Save failed');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setSaveError(true);
      setTimeout(() => setSaveError(false), 3000);
    } finally {
      setSaving(false);
    }
  }, [criteria]);

  const addTag = (field: keyof CriteriaData, tag: string) => {
    const current = criteria[field];
    if (Array.isArray(current) && !current.includes(tag)) {
      setCriteria({ ...criteria, [field]: [...current, tag] });
    }
  };

  const removeTag = (field: keyof CriteriaData, index: number) => {
    const current = criteria[field];
    if (Array.isArray(current)) {
      setCriteria({ ...criteria, [field]: current.filter((_, i) => i !== index) });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground font-medium">Loading your settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-sm">S</span>
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Scout Settings</h1>
              <p className="text-xs text-muted-foreground hidden sm:block">Configure your job search criteria</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400 font-medium animate-in fade-in duration-200">
                <Check className="h-4 w-4" />
                Saved
              </span>
            )}
            {saveError && (
              <span className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400 font-medium animate-in fade-in duration-200">
                <AlertCircle className="h-4 w-4" />
                Failed
              </span>
            )}
            <Button
              onClick={handleSave}
              disabled={saving}
              size="sm"
              className="min-w-[100px] font-semibold shadow-sm transition-all duration-200 hover:shadow-md"
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  Saving...
                </>
              ) : "Save Settings"}
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Compensation & Work Type */}
        <Card className="shadow-sm border-border/50 overflow-hidden transition-shadow hover:shadow-md">
          <CardHeader className="pb-4">
            <div className="flex items-start gap-3">
              <SectionIcon><DollarSign className="h-4 w-4" /></SectionIcon>
              <div>
                <CardTitle className="text-base">Compensation & Work Type</CardTitle>
                <CardDescription className="mt-0.5 text-xs">Set your minimum salary floor and preferred work arrangement</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="min-salary" className="text-sm font-semibold">Minimum Base Pay</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                  <Input
                    id="min-salary"
                    type="number"
                    className="pl-7 bg-background/50 transition-all duration-200 focus:ring-2 focus:ring-primary/20"
                    placeholder="e.g. 130000"
                    value={criteria.min_salary ?? ""}
                    onChange={(e) =>
                      setCriteria({
                        ...criteria,
                        min_salary: e.target.value ? parseInt(e.target.value, 10) : null,
                      })
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="work-type" className="text-sm font-semibold">Work Type</Label>
                <Select
                  value={criteria.work_type}
                  onValueChange={(val) => setCriteria({ ...criteria, work_type: val as WorkType })}
                >
                  <SelectTrigger id="work-type" className="bg-background/50 transition-all duration-200 focus:ring-2 focus:ring-primary/20">
                    <SelectValue placeholder="Select work type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any (No Preference)</SelectItem>
                    <SelectItem value="remote">Remote Only</SelectItem>
                    <SelectItem value="office">On-site</SelectItem>
                    <SelectItem value="hybrid">Hybrid</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Location */}
        <Card className="shadow-sm border-border/50 overflow-hidden transition-shadow hover:shadow-md">
          <CardHeader className="pb-4">
            <div className="flex items-start gap-3">
              <SectionIcon><MapPin className="h-4 w-4" /></SectionIcon>
              <div>
                <CardTitle className="text-base">Location</CardTitle>
                <CardDescription className="mt-0.5 text-xs">Jobs outside these locations are excluded before scoring</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <TagInput
              label="Preferred Locations"
              description="Jobs must match at least one. 'Remote' allows remote jobs. 'United States' allows any US location."
              tags={criteria.locations}
              onAdd={(tag) => addTag("locations", tag)}
              onRemove={(i) => removeTag("locations", i)}
              placeholder="Type a location and press Enter"
            />
          </CardContent>
        </Card>

        {/* Roles & Industries */}
        <Card className="shadow-sm border-border/50 overflow-hidden transition-shadow hover:shadow-md">
          <CardHeader className="pb-4">
            <div className="flex items-start gap-3">
              <SectionIcon><Briefcase className="h-4 w-4" /></SectionIcon>
              <div>
                <CardTitle className="text-base">Roles & Industries</CardTitle>
                <CardDescription className="mt-0.5 text-xs">Target specific job titles and industry sectors</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <TagInput
              label="Target Roles"
              tags={criteria.target_roles}
              onAdd={(tag) => addTag("target_roles", tag)}
              onRemove={(i) => removeTag("target_roles", i)}
              placeholder="e.g. Account Executive, Sales Director"
            />
            <div className="border-t border-border/30" />
            <TagInput
              label="Industries"
              tags={criteria.industries}
              onAdd={(tag) => addTag("industries", tag)}
              onRemove={(i) => removeTag("industries", i)}
              placeholder="e.g. AI Infrastructure, Data Centers"
            />
          </CardContent>
        </Card>

        {/* Keywords */}
        <Card className="shadow-sm border-border/50 overflow-hidden transition-shadow hover:shadow-md">
          <CardHeader className="pb-4">
            <div className="flex items-start gap-3">
              <SectionIcon><Filter className="h-4 w-4" /></SectionIcon>
              <div>
                <CardTitle className="text-base">Keywords</CardTitle>
                <CardDescription className="mt-0.5 text-xs">Fine-tune which jobs get flagged, boosted, or filtered out</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <TagInput
              label="Must Have"
              description="Jobs missing ALL of these will score low"
              tags={criteria.must_have}
              onAdd={(tag) => addTag("must_have", tag)}
              onRemove={(i) => removeTag("must_have", i)}
              placeholder="e.g. enterprise sales, quota carrying"
              accentColor="green"
            />
            <div className="border-t border-border/30" />
            <TagInput
              label="Nice to Have"
              description="Boost score if these appear"
              tags={criteria.nice_to_have}
              onAdd={(tag) => addTag("nice_to_have", tag)}
              onRemove={(i) => removeTag("nice_to_have", i)}
              placeholder="e.g. AI, data center, GPU"
              accentColor="amber"
            />
            <div className="border-t border-border/30" />
            <TagInput
              label="Avoid"
              description="Reduce score significantly when these terms appear"
              tags={criteria.avoid}
              onAdd={(tag) => addTag("avoid", tag)}
              onRemove={(i) => removeTag("avoid", i)}
              placeholder="e.g. SDR, BDR, inbound only"
              accentColor="red"
            />
          </CardContent>
        </Card>

        {/* Your Info */}
        <Card className="shadow-sm border-border/50 overflow-hidden transition-shadow hover:shadow-md">
          <CardHeader className="pb-4">
            <div className="flex items-start gap-3">
              <SectionIcon><User className="h-4 w-4" /></SectionIcon>
              <div>
                <CardTitle className="text-base">Your Info</CardTitle>
                <CardDescription className="mt-0.5 text-xs">Used for digest emails and tailored documents</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="your-name" className="text-sm font-semibold">Name</Label>
                <Input
                  id="your-name"
                  value={criteria.your_name}
                  onChange={(e) => setCriteria({ ...criteria, your_name: e.target.value })}
                  placeholder="Your full name"
                  className="bg-background/50 transition-all duration-200 focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="your-email" className="text-sm font-semibold">Email</Label>
                <Input
                  id="your-email"
                  type="email"
                  value={criteria.your_email}
                  onChange={(e) => setCriteria({ ...criteria, your_email: e.target.value })}
                  placeholder="you@example.com"
                  className="bg-background/50 transition-all duration-200 focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Bottom save bar for mobile */}
        <div className="sm:hidden fixed bottom-0 left-0 right-0 bg-background/80 backdrop-blur-xl border-t border-border/50 p-4 z-10">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="w-full font-semibold shadow-sm"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Saving...
              </>
            ) : "Save Settings"}
          </Button>
        </div>

        {/* Spacer for fixed bottom bar on mobile */}
        <div className="h-16 sm:hidden" />
      </div>
    </div>
  );
}
