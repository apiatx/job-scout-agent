import { motion } from "framer-motion";
import { Briefcase, Target, Trophy, Clock, Play, ArrowRight, Activity, Mail } from "lucide-react";
import { Link } from "wouter";
import { useListJobs, useGetScoutStatus } from "@workspace/api-client-react";
import { useScoutMutations } from "@/hooks/use-scout-api";
import { getScoreColor } from "@/lib/utils";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: jobs, isLoading: jobsLoading } = useListJobs();
  const { data: scoutHistory, isLoading: historyLoading } = useGetScoutStatus();
  const { runScout } = useScoutMutations();

  const handleRunScout = () => {
    runScout.mutate();
  };

  const totalJobs = jobs?.length || 0;
  const newJobs = jobs?.filter(j => j.status === 'new').length || 0;
  
  const highMatchJobs = jobs?.filter(j => j.matchScore >= 80) || [];
  const avgScore = jobs?.length ? Math.round(jobs.reduce((acc, j) => acc + j.matchScore, 0) / jobs.length) : 0;

  const latestRun = scoutHistory?.[0];
  const isRunning = latestRun?.status === 'running';

  return (
    <div className="space-y-8 pb-12">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">Overview</h1>
          <p className="text-muted-foreground mt-1 text-lg">Here's what your scout has found for you.</p>
        </div>
        <button
          onClick={handleRunScout}
          disabled={isRunning || runScout.isPending}
          className="flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold bg-primary text-primary-foreground shadow-[0_0_20px_rgba(var(--primary),0.3)] hover:shadow-[0_0_30px_rgba(var(--primary),0.5)] hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning || runScout.isPending ? (
            <><Activity className="w-5 h-5 animate-pulse" /> Scouting...</>
          ) : (
            <><Play className="w-5 h-5 fill-current" /> Run Scout Now</>
          )}
        </button>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
        {[
          { label: "Total Matches", value: totalJobs, icon: Briefcase, color: "text-blue-400", bg: "bg-blue-400/10" },
          { label: "New Today", value: newJobs, icon: Target, color: "text-emerald-400", bg: "bg-emerald-400/10" },
          { label: "Avg Match Score", value: `${avgScore}%`, icon: Trophy, color: "text-amber-400", bg: "bg-amber-400/10" },
          { label: "Last Run", value: latestRun ? format(new Date(latestRun.startedAt), 'MMM d, h:mm a') : 'Never', icon: Clock, color: "text-purple-400", bg: "bg-purple-400/10", textClass: "text-sm" },
        ].map((stat, i) => (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            key={i}
            className="glass-card p-6 rounded-2xl flex items-start gap-4 relative overflow-hidden"
          >
            <div className={`p-3 rounded-xl ${stat.bg}`}>
              <stat.icon className={`w-6 h-6 ${stat.color}`} />
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">{stat.label}</p>
              {jobsLoading || historyLoading ? (
                <div className="h-8 w-16 bg-secondary animate-pulse rounded" />
              ) : (
                <p className={`font-display font-bold text-2xl text-foreground ${stat.textClass || ''}`}>{stat.value}</p>
              )}
            </div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Top Matches */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-display font-bold">Top Recent Matches</h2>
            <Link href="/jobs" className="text-sm text-primary hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          
          <div className="space-y-4">
            {jobsLoading ? (
              [1, 2, 3].map(i => <div key={i} className="h-24 glass-card rounded-2xl animate-pulse" />)
            ) : highMatchJobs.length > 0 ? (
              highMatchJobs.slice(0, 5).map((job, i) => (
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.1 }}
                  key={job.id}
                  className="glass-card p-5 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold text-lg text-foreground truncate">{job.title}</h3>
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-secondary text-muted-foreground border border-border">
                        {job.status}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-sm flex items-center gap-2">
                      <Building2 className="w-4 h-4" /> {job.company}
                      <span className="text-border">•</span>
                      <span>{job.location}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className={`px-3 py-1.5 rounded-xl border font-bold flex flex-col items-center justify-center min-w-[70px] ${getScoreColor(job.matchScore)}`}>
                      <span className="text-xs uppercase tracking-wider opacity-80">Match</span>
                      <span className="text-lg leading-none">{job.matchScore}</span>
                    </div>
                    <Link href={`/jobs`} className="p-2 rounded-xl bg-secondary hover:bg-primary hover:text-primary-foreground transition-colors">
                      <ArrowRight className="w-5 h-5" />
                    </Link>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="glass-card p-12 text-center rounded-2xl border-dashed">
                <Target className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <h3 className="text-lg font-bold mb-1">No high matches yet</h3>
                <p className="text-muted-foreground">Run the scout or refine your criteria to find better jobs.</p>
              </div>
            )}
          </div>
        </div>

        {/* Scout Run History */}
        <div className="space-y-4">
          <h2 className="text-xl font-display font-bold">Activity Log</h2>
          <div className="glass-card rounded-2xl overflow-hidden">
            {historyLoading ? (
              <div className="p-6 flex justify-center"><Activity className="w-6 h-6 animate-spin text-primary" /></div>
            ) : scoutHistory && scoutHistory.length > 0 ? (
              <div className="divide-y divide-border/50">
                {scoutHistory.slice(0, 6).map((run) => (
                  <div key={run.id} className="p-4 flex items-center gap-4 hover:bg-white/[0.02] transition-colors">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center border ${
                      run.status === 'completed' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
                      run.status === 'failed' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                      'bg-blue-500/10 border-blue-500/20 text-blue-400 animate-pulse'
                    }`}>
                      {run.status === 'completed' ? <Briefcase className="w-5 h-5" /> :
                       run.status === 'failed' ? <X className="w-5 h-5" /> :
                       <Activity className="w-5 h-5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {run.status === 'completed' ? `Found ${run.jobsFound} jobs` :
                         run.status === 'failed' ? 'Scout failed' : 'Scout running...'}
                      </p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3" /> {format(new Date(run.startedAt), 'MMM d, h:mm a')}
                      </p>
                    </div>
                    {run.emailSent && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                             <Mail className="w-4 h-4 text-primary opacity-70" />
                          </TooltipTrigger>
                          <TooltipContent>Digest Email Sent</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground text-sm">
                No activity yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Simple Tooltip components since they are missing from ui folder context
import { ReactNode } from "react";
const TooltipProvider = ({children}: {children: ReactNode}) => <>{children}</>;
const Tooltip = ({children}: {children: ReactNode}) => <div className="group relative inline-block">{children}</div>;
const TooltipTrigger = ({children}: {children: ReactNode}) => <>{children}</>;
const TooltipContent = ({children}: {children: ReactNode}) => (
  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block px-2 py-1 bg-popover text-popover-foreground text-xs rounded shadow-lg whitespace-nowrap z-50 border">
    {children}
  </div>
);
