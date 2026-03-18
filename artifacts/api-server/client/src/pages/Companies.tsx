import { useState } from "react";
import { Building2, Plus, Trash2, Globe, Server } from "lucide-react";
import { useListCompanies } from "@workspace/api-client-react";
import { useScoutMutations } from "@/hooks/use-scout-api";
import { format } from "date-fns";

export default function Companies() {
  const { data: companies, isLoading } = useListCompanies();
  const { createCompany, deleteCompany } = useScoutMutations();
  
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    atsType: "greenhouse",
    atsSlug: "",
    careersUrl: ""
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createCompany.mutate({
      data: {
        name: formData.name,
        atsType: formData.atsType as any,
        atsSlug: formData.atsSlug || null,
        careersUrl: formData.careersUrl || null
      }
    }, {
      onSuccess: () => {
        setIsAddOpen(false);
        setFormData({ name: "", atsType: "greenhouse", atsSlug: "", careersUrl: "" });
      }
    });
  };

  return (
    <div className="space-y-8 pb-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">Target Companies</h1>
          <p className="text-muted-foreground mt-1 text-lg">Manage the companies the scout actively monitors.</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold bg-primary text-primary-foreground shadow-lg hover:shadow-xl hover:shadow-primary/20 hover:-translate-y-0.5 transition-all duration-200"
        >
          <Plus className="w-5 h-5" /> Add Company
        </button>
      </div>

      {isAddOpen && (
        <div className="glass-card p-6 rounded-2xl border-primary/30 relative">
          <button onClick={() => setIsAddOpen(false)} className="absolute top-4 right-4 text-muted-foreground hover:text-foreground">
            ✕
          </button>
          <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" /> Add New Target
          </h3>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Company Name</label>
              <input required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-background/50 border-2 border-border focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all" placeholder="e.g. Anthropic" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">ATS Provider</label>
              <div className="relative">
                <select value={formData.atsType} onChange={e => setFormData({...formData, atsType: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-background/50 border-2 border-border focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all appearance-none cursor-pointer">
                  <option value="greenhouse">Greenhouse (API)</option>
                  <option value="lever">Lever (API)</option>
                  <option value="workday">Workday (Scraper)</option>
                  <option value="other">Other (Scraper)</option>
                </select>
                <Server className="w-4 h-4 absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground flex items-center justify-between">
                <span>ATS Slug / Job Board ID</span>
                <span className="text-xs text-muted-foreground font-normal">If API based</span>
              </label>
              <input value={formData.atsSlug} onChange={e => setFormData({...formData, atsSlug: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-background/50 border-2 border-border focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all" placeholder="e.g. anthropic" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground flex items-center justify-between">
                <span>Careers Page URL</span>
                <span className="text-xs text-muted-foreground font-normal">If Scraper based</span>
              </label>
              <input type="url" value={formData.careersUrl} onChange={e => setFormData({...formData, careersUrl: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-background/50 border-2 border-border focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all" placeholder="https://..." />
            </div>
            <div className="md:col-span-2 flex justify-end pt-2">
              <button type="submit" disabled={createCompany.isPending} className="px-8 py-3 rounded-xl bg-primary text-white font-bold hover:bg-primary/90 transition-colors disabled:opacity-50">
                {createCompany.isPending ? "Adding..." : "Save Company"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          [1, 2, 3].map(i => <div key={i} className="h-32 glass-card rounded-2xl animate-pulse" />)
        ) : companies?.length === 0 ? (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            No companies added yet. Start adding targets to begin scouting.
          </div>
        ) : (
          companies?.map((company) => (
            <div key={company.id} className="glass-card rounded-2xl p-6 flex flex-col justify-between group relative overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-primary/10 to-transparent rounded-bl-full pointer-events-none" />
              <div>
                <div className="flex items-start justify-between mb-4">
                  <div className="w-12 h-12 rounded-xl bg-secondary/50 border border-border/50 flex items-center justify-center text-xl font-display font-bold text-foreground">
                    {company.name.charAt(0)}
                  </div>
                  <button
                    onClick={() => {
                      if (confirm("Remove this company?")) deleteCompany.mutate({ id: company.id });
                    }}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <h3 className="text-xl font-bold text-foreground truncate">{company.name}</h3>
                <div className="flex items-center gap-2 mt-2">
                  <span className="px-2.5 py-0.5 rounded-md text-xs font-semibold bg-secondary border border-border/50 text-muted-foreground capitalize flex items-center gap-1">
                    <Server className="w-3 h-3" /> {company.atsType}
                  </span>
                </div>
              </div>
              <div className="mt-6 pt-4 border-t border-border/50 flex flex-col gap-2 text-sm text-muted-foreground">
                {company.atsSlug && (
                  <div className="flex items-center justify-between">
                    <span className="font-medium">API Slug</span>
                    <span className="text-foreground font-mono bg-black/20 px-2 py-0.5 rounded">{company.atsSlug}</span>
                  </div>
                )}
                {company.careersUrl && (
                  <a href={company.careersUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-primary hover:underline mt-1 w-fit">
                    <Globe className="w-4 h-4" /> Visit Careers
                  </a>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
