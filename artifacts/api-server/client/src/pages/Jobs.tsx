import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Building2, MapPin, DollarSign, ExternalLink, ChevronDown, Check, X, FileText, Sparkles } from "lucide-react";
import { useListJobs } from "@workspace/api-client-react";
import { useScoutMutations } from "@/hooks/use-scout-api";
import { getScoreColor, cn } from "@/lib/utils";
import { format } from "date-fns";

type Tab = "new" | "saved" | "applied" | "dismissed";

export default function Jobs() {
  const [activeTab, setActiveTab] = useState<Tab>("new");
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  
  const { data: jobs, isLoading } = useListJobs();
  const { updateJobStatus, generateDocs } = useScoutMutations();

  const filteredJobs = jobs?.filter(job => job.status === activeTab).sort((a, b) => b.matchScore - a.matchScore) || [];

  const handleStatusChange = (id: number, status: string) => {
    updateJobStatus.mutate({ id, data: { status } });
    if (expandedJobId === id) setExpandedJobId(null);
  };

  const handleGenerateDocs = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    generateDocs.mutate({ id });
    setExpandedJobId(id);
  };

  return (
    <div className="space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Job Matches</h1>
        <p className="text-muted-foreground mt-1 text-lg">Review, organize, and apply to your top matches.</p>
      </div>

      <div className="flex flex-wrap gap-2 p-1 bg-secondary/50 backdrop-blur-md border border-border/50 rounded-2xl w-fit">
        {(["new", "saved", "applied", "dismissed"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-5 py-2.5 rounded-xl font-medium text-sm transition-all duration-300 capitalize",
              activeTab === tab 
                ? "bg-card text-foreground shadow-sm border border-border/50" 
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            )}
          >
            {tab}
            <span className="ml-2 px-1.5 py-0.5 rounded-md bg-secondary text-xs opacity-80">
              {jobs?.filter(j => j.status === tab).length || 0}
            </span>
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {isLoading ? (
          [1, 2, 3].map(i => <div key={i} className="h-40 glass-card rounded-2xl animate-pulse" />)
        ) : filteredJobs.length === 0 ? (
          <div className="glass-card p-16 text-center rounded-2xl border-dashed">
            <Briefcase className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
            <h3 className="text-xl font-bold mb-2">No jobs found in {activeTab}</h3>
            <p className="text-muted-foreground max-w-sm mx-auto">When the scout runs, new jobs that match your criteria will appear here.</p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {filteredJobs.map((job) => (
              <motion.div
                layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                key={job.id}
                className={cn(
                  "glass-card rounded-2xl overflow-hidden transition-all duration-300",
                  expandedJobId === job.id ? "ring-2 ring-primary/50" : ""
                )}
              >
                <div 
                  className="p-5 md:p-6 cursor-pointer"
                  onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
                >
                  <div className="flex flex-col md:flex-row gap-6">
                    <div className="flex-1 space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="text-xl font-bold text-foreground leading-tight">{job.title}</h3>
                          <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-muted-foreground font-medium">
                            <span className="flex items-center gap-1.5 text-foreground"><Building2 className="w-4 h-4 text-primary" /> {job.company}</span>
                            <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {job.location}</span>
                            {job.salary && <span className="flex items-center gap-1.5 text-emerald-400"><DollarSign className="w-4 h-4" /> {job.salary}</span>}
                          </div>
                        </div>
                        <div className={`px-4 py-2 rounded-xl border-2 font-bold flex flex-col items-center justify-center min-w-[80px] shadow-inner ${getScoreColor(job.matchScore)}`}>
                          <span className="text-2xl leading-none">{job.matchScore}</span>
                          <span className="text-[10px] uppercase tracking-widest opacity-80 mt-1">Match</span>
                        </div>
                      </div>
                      
                      <div className="bg-secondary/30 rounded-xl p-4 border border-border/50">
                        <div className="flex items-center gap-2 mb-2">
                          <Sparkles className="w-4 h-4 text-amber-400" />
                          <h4 className="font-semibold text-sm">Why it fits</h4>
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">{job.whyGoodFit}</p>
                      </div>
                    </div>

                    <div className="flex flex-row md:flex-col justify-end md:justify-start gap-2 pt-2 md:border-l border-border/50 md:pl-6 min-w-[140px]">
                      {activeTab === 'new' && (
                        <>
                          <button onClick={(e) => { e.stopPropagation(); handleStatusChange(job.id, 'saved'); }} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium bg-primary/10 text-primary hover:bg-primary hover:text-white transition-colors">
                            <Check className="w-4 h-4" /> Save
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleStatusChange(job.id, 'dismissed'); }} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium bg-secondary text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors">
                            <X className="w-4 h-4" /> Dismiss
                          </button>
                        </>
                      )}
                      {(activeTab === 'saved' || activeTab === 'applied') && (
                        <>
                          <a href={job.applyUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-primary/40 transition-all">
                            Apply <ExternalLink className="w-4 h-4" />
                          </a>
                          {activeTab === 'saved' && (
                            <button onClick={(e) => { e.stopPropagation(); handleStatusChange(job.id, 'applied'); }} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-border hover:bg-secondary transition-colors text-sm">
                              Mark Applied
                            </button>
                          )}
                        </>
                      )}
                      
                      <div className="flex-1 hidden md:flex items-end justify-center pt-4">
                        <div className="flex items-center gap-1 text-muted-foreground text-xs font-medium">
                          {expandedJobId === job.id ? 'Show less' : 'View Details'} <ChevronDown className={cn("w-4 h-4 transition-transform", expandedJobId === job.id && "rotate-180")} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {expandedJobId === job.id && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="border-t border-border bg-black/20"
                    >
                      <div className="p-6 space-y-6">
                        <div className="flex items-center justify-between">
                          <h4 className="text-lg font-bold flex items-center gap-2">
                            <FileText className="w-5 h-5 text-primary" /> Application Materials
                          </h4>
                          {(!job.tailoredResume || !job.coverLetter) && (
                            <button
                              onClick={(e) => handleGenerateDocs(job.id, e)}
                              disabled={generateDocs.isPending}
                              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-purple-500 text-white font-medium shadow-lg hover:shadow-xl hover:opacity-90 transition-all disabled:opacity-50"
                            >
                              {generateDocs.isPending && generateDocs.variables?.id === job.id ? (
                                "Generating..."
                              ) : (
                                <><Sparkles className="w-4 h-4" /> Generate with AI</>
                              )}
                            </button>
                          )}
                        </div>

                        {job.tailoredResume && job.coverLetter ? (
                          <div className="grid md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                              <h5 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Tailored Cover Letter</h5>
                              <div className="bg-secondary/50 p-4 rounded-xl text-sm text-foreground/90 whitespace-pre-wrap font-mono h-96 overflow-y-auto border border-border">
                                {job.coverLetter}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <h5 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Tailored Resume Points</h5>
                              <div className="bg-secondary/50 p-4 rounded-xl text-sm text-foreground/90 whitespace-pre-wrap font-mono h-96 overflow-y-auto border border-border">
                                {job.tailoredResume}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="text-center py-8 text-muted-foreground">
                            Click "Generate with AI" to create a custom cover letter and resume tweaks specifically for this role.
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
