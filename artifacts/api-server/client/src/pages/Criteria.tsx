import { useState, useEffect } from "react";
import { SlidersHorizontal, Save, Sparkles } from "lucide-react";
import { useGetCriteria } from "@workspace/api-client-react";
import { useScoutMutations } from "@/hooks/use-scout-api";
import { TagInput } from "@/components/ui/TagInput";

export default function Criteria() {
  const { data: criteria, isLoading } = useGetCriteria();
  const { updateCriteria } = useScoutMutations();

  const [formData, setFormData] = useState({
    targetRoles: [] as string[],
    industries: [] as string[],
    locations: [] as string[],
    mustHave: [] as string[],
    niceToHave: [] as string[],
    avoid: [] as string[],
    minSalary: "" as string,
    yourName: "",
    yourEmail: ""
  });

  useEffect(() => {
    if (criteria) {
      setFormData({
        targetRoles: criteria.targetRoles || [],
        industries: criteria.industries || [],
        locations: criteria.locations || [],
        mustHave: criteria.mustHave || [],
        niceToHave: criteria.niceToHave || [],
        avoid: criteria.avoid || [],
        minSalary: criteria.minSalary ? criteria.minSalary.toString() : "",
        yourName: criteria.yourName || "",
        yourEmail: criteria.yourEmail || ""
      });
    }
  }, [criteria]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateCriteria.mutate({
      data: {
        ...formData,
        minSalary: formData.minSalary ? parseInt(formData.minSalary, 10) : null
      }
    });
  };

  if (isLoading) {
    return <div className="p-8 text-center animate-pulse">Loading criteria...</div>;
  }

  return (
    <div className="space-y-8 pb-12 max-w-4xl">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Search Criteria</h1>
        <p className="text-muted-foreground mt-1 text-lg">Configure what the AI scout looks for in job listings.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        
        <div className="glass-card p-6 md:p-8 rounded-2xl space-y-6">
          <div className="border-b border-border/50 pb-4 mb-6">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <SlidersHorizontal className="w-5 h-5 text-primary" /> Core Targeting
            </h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Target Roles</label>
              <TagInput value={formData.targetRoles} onChange={v => setFormData({...formData, targetRoles: v})} placeholder="e.g. Frontend Engineer, Full Stack" />
              <p className="text-xs text-muted-foreground">Press Enter to add multiple</p>
            </div>
            
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Locations</label>
              <TagInput value={formData.locations} onChange={v => setFormData({...formData, locations: v})} placeholder="e.g. Remote, New York, SF" />
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Industries</label>
              <TagInput value={formData.industries} onChange={v => setFormData({...formData, industries: v})} placeholder="e.g. SaaS, FinTech, AI" />
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Minimum Salary (USD)</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                <input 
                  type="number" 
                  value={formData.minSalary} 
                  onChange={e => setFormData({...formData, minSalary: e.target.value})} 
                  className="w-full pl-8 pr-4 py-3 rounded-xl bg-background/50 border-2 border-input focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all" 
                  placeholder="120000" 
                />
              </div>
            </div>
          </div>
        </div>

        <div className="glass-card p-6 md:p-8 rounded-2xl space-y-6">
          <div className="border-b border-border/50 pb-4 mb-6">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-400" /> AI Scoring Weights
            </h2>
            <p className="text-sm text-muted-foreground mt-1">The AI uses these to calculate the Match Score (0-100)</p>
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <label className="text-sm font-medium text-emerald-400">Must Have (Dealbreakers)</label>
              <TagInput className="border-emerald-500/20 focus-within:border-emerald-500" value={formData.mustHave} onChange={v => setFormData({...formData, mustHave: v})} placeholder="e.g. React, TypeScript, 3+ years experience" />
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-blue-400">Nice to Have (Bonus points)</label>
              <TagInput className="border-blue-500/20 focus-within:border-blue-500" value={formData.niceToHave} onChange={v => setFormData({...formData, niceToHave: v})} placeholder="e.g. GraphQL, Tailwind, Startup experience" />
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-red-400">Avoid (Red flags)</label>
              <TagInput className="border-red-500/20 focus-within:border-red-500" value={formData.avoid} onChange={v => setFormData({...formData, avoid: v})} placeholder="e.g. Angular, Crypto, Agency" />
            </div>
          </div>
        </div>

        <div className="glass-card p-6 md:p-8 rounded-2xl space-y-6">
          <div className="border-b border-border/50 pb-4 mb-6">
            <h2 className="text-xl font-bold">Personal Details</h2>
            <p className="text-sm text-muted-foreground mt-1">Used when generating tailored cover letters</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Your Name</label>
              <input required value={formData.yourName} onChange={e => setFormData({...formData, yourName: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-background/50 border-2 border-input focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all" placeholder="Jane Doe" />
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Your Email</label>
              <input required type="email" value={formData.yourEmail} onChange={e => setFormData({...formData, yourEmail: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-background/50 border-2 border-input focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all" placeholder="jane@example.com" />
            </div>
          </div>
        </div>

        <div className="flex justify-end sticky bottom-8">
          <button 
            type="submit" 
            disabled={updateCriteria.isPending}
            className="flex items-center gap-2 px-8 py-4 rounded-xl font-bold bg-primary text-primary-foreground shadow-xl shadow-primary/30 hover:-translate-y-1 hover:shadow-2xl hover:shadow-primary/40 transition-all disabled:opacity-50 disabled:transform-none"
          >
            <Save className="w-5 h-5" /> 
            {updateCriteria.isPending ? "Saving..." : "Save Configuration"}
          </button>
        </div>

      </form>
    </div>
  );
}
