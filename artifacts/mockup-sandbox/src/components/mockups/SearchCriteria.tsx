import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";

type WorkType = "any" | "remote" | "office" | "hybrid";

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
}: {
  label: string;
  description?: string;
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (index: number) => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && value.trim()) {
      e.preventDefault();
      onAdd(value.trim());
      setValue("");
    }
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map((tag, i) => (
          <Badge key={i} variant="secondary" className="gap-1 pr-1">
            {tag}
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? `Add ${label.toLowerCase()} and press Enter`}
      />
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/criteria")
      .then((r) => r.json())
      .then((data) => {
        if (data && data.id) {
          setCriteria({
            min_salary: data.min_salary ?? null,
            work_type: data.work_type ?? "any",
            locations: data.locations ?? [],
            target_roles: data.target_roles ?? [],
            industries: data.industries ?? [],
            must_have: data.must_have ?? [],
            nice_to_have: data.nice_to_have ?? [],
            avoid: data.avoid ?? [],
            your_name: data.your_name ?? "",
            your_email: data.your_email ?? "",
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/criteria", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(criteria),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // handle error silently
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
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Search Criteria</h1>
        <p className="text-muted-foreground mt-1">
          This is the single source of truth for all scoring. Whatever you set here flows directly into the scout's scoring prompt.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Compensation &amp; Work Type</CardTitle>
          <CardDescription>Jobs with listed salary below minimum are excluded. If salary is not listed, the job is kept.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="min-salary">Minimum Base Pay</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
              <Input
                id="min-salary"
                type="number"
                className="pl-7"
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
            <Label htmlFor="work-type">Work Type</Label>
            <Select
              value={criteria.work_type}
              onValueChange={(val) => setCriteria({ ...criteria, work_type: val as WorkType })}
            >
              <SelectTrigger id="work-type">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Location</CardTitle>
          <CardDescription>Hard filter — jobs outside these locations are excluded entirely before scoring</CardDescription>
        </CardHeader>
        <CardContent>
          <TagInput
            label="Preferred Locations"
            description="Jobs must match at least one of these. 'Remote' allows remote jobs. 'United States' allows any US location."
            tags={criteria.locations}
            onAdd={(tag) => addTag("locations", tag)}
            onRemove={(i) => removeTag("locations", i)}
            placeholder="Type a location and press Enter"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Roles &amp; Industries</CardTitle>
          <CardDescription>Target specific job titles and industry sectors</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <TagInput
            label="Target Roles"
            tags={criteria.target_roles}
            onAdd={(tag) => addTag("target_roles", tag)}
            onRemove={(i) => removeTag("target_roles", i)}
            placeholder="e.g. Account Executive, Sales Director"
          />
          <TagInput
            label="Industries"
            tags={criteria.industries}
            onAdd={(tag) => addTag("industries", tag)}
            onRemove={(i) => removeTag("industries", i)}
            placeholder="e.g. AI Infrastructure, Data Centers"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keywords</CardTitle>
          <CardDescription>Fine-tune which jobs get flagged or filtered out</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <TagInput
            label="Must Have"
            description="Jobs missing ALL of these will score low"
            tags={criteria.must_have}
            onAdd={(tag) => addTag("must_have", tag)}
            onRemove={(i) => removeTag("must_have", i)}
            placeholder="e.g. enterprise sales, quota carrying"
          />
          <TagInput
            label="Nice to Have"
            description="Boost score if these appear"
            tags={criteria.nice_to_have}
            onAdd={(tag) => addTag("nice_to_have", tag)}
            onRemove={(i) => removeTag("nice_to_have", i)}
            placeholder="e.g. AI, data center, GPU"
          />
          <TagInput
            label="Avoid"
            description="Hard filter — jobs containing these terms are excluded before scoring"
            tags={criteria.avoid}
            onAdd={(tag) => addTag("avoid", tag)}
            onRemove={(i) => removeTag("avoid", i)}
            placeholder="e.g. SDR, BDR, inbound only"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your Info</CardTitle>
          <CardDescription>Used for daily digest emails and tailored documents</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="your-name">Name</Label>
            <Input
              id="your-name"
              value={criteria.your_name}
              onChange={(e) => setCriteria({ ...criteria, your_name: e.target.value })}
              placeholder="Your full name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="your-email">Email</Label>
            <Input
              id="your-email"
              type="email"
              value={criteria.your_email}
              onChange={(e) => setCriteria({ ...criteria, your_email: e.target.value })}
              placeholder="you@example.com"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </Button>
        {saved && <span className="text-sm text-green-600">Settings saved!</span>}
      </div>
    </div>
  );
}
