import { Mail, CheckCircle2, AlertCircle, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { useGetGmailStatus, useGetGmailSetupUrl } from "@workspace/api-client-react";
import { useScoutMutations } from "@/hooks/use-scout-api";

export default function Gmail() {
  const { data: status, isLoading: statusLoading } = useGetGmailStatus();
  const { data: setupUrl } = useGetGmailSetupUrl();
  const { disconnectGmail, sendDigest } = useScoutMutations();

  if (statusLoading) return <div className="p-8 text-center animate-pulse">Loading status...</div>;

  return (
    <div className="space-y-8 pb-12 max-w-3xl">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Gmail Integration</h1>
        <p className="text-muted-foreground mt-1 text-lg">Receive daily digests of your top job matches automatically.</p>
      </div>

      <div className="glass-card rounded-3xl overflow-hidden border-2 border-border/50">
        {/* Status Header */}
        <div className={`p-8 border-b border-border/50 relative overflow-hidden ${status?.connected ? 'bg-emerald-500/5' : 'bg-secondary/30'}`}>
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl pointer-events-none" />
          
          <div className="flex items-start justify-between relative z-10">
            <div className="flex items-center gap-4">
              <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border-2 shadow-lg ${
                status?.connected ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-card border-border text-muted-foreground'
              }`}>
                <Mail className="w-8 h-8" />
              </div>
              <div>
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  {status?.connected ? (
                    <><span className="text-emerald-400">Connected</span> <CheckCircle2 className="w-6 h-6 text-emerald-400" /></>
                  ) : (
                    <><span className="text-foreground">Not Connected</span> <AlertCircle className="w-6 h-6 text-muted-foreground" /></>
                  )}
                </h2>
                {status?.email && (
                  <p className="text-muted-foreground mt-1 font-medium">{status.email}</p>
                )}
              </div>
            </div>
            
            {status?.connected && (
              <button 
                onClick={() => disconnectGmail.mutate()}
                disabled={disconnectGmail.isPending}
                className="px-4 py-2 rounded-lg font-medium text-sm border border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-all disabled:opacity-50"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Action Area */}
        <div className="p-8 bg-card/50">
          {!status?.connected ? (
            <div className="space-y-6">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-5 text-blue-200">
                <h3 className="font-bold flex items-center gap-2 mb-2 text-blue-400">
                  <ShieldAlert className="w-5 h-5" /> OAuth Requirements
                </h3>
                <p className="text-sm leading-relaxed">
                  To send emails on your behalf, this app uses Google's official OAuth flow. You will be redirected to Google to authorize access. 
                  We only request permission to send emails, not read your inbox.
                </p>
              </div>

              {setupUrl && (
                <div className="flex flex-col items-center p-8 bg-background/50 rounded-2xl border border-dashed border-border text-center">
                  <Mail className="w-12 h-12 text-primary/50 mb-4" />
                  <h3 className="text-xl font-bold mb-2">Ready to connect</h3>
                  <p className="text-muted-foreground mb-6 max-w-sm">Click the button below to authenticate with Google securely.</p>
                  <a 
                    href={setupUrl.url}
                    className="flex items-center gap-2 px-8 py-4 rounded-xl font-bold bg-white text-black shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    Sign in with Google
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-6 bg-background/50 rounded-2xl border border-border">
                  <h3 className="font-bold mb-1">Daily Digest</h3>
                  <p className="text-sm text-muted-foreground mb-4">Automatically runs every morning at 8AM and emails you the best matches.</p>
                  <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4" /> Active
                  </div>
                </div>
                
                <div className="p-6 bg-background/50 rounded-2xl border border-border flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold mb-1">Manual Test</h3>
                    <p className="text-sm text-muted-foreground mb-4">Send a digest right now with the current 'New' jobs.</p>
                  </div>
                  <button 
                    onClick={() => sendDigest.mutate()}
                    disabled={sendDigest.isPending}
                    className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl font-bold bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {sendDigest.isPending ? (
                      <><RefreshCw className="w-4 h-4 animate-spin" /> Sending...</>
                    ) : (
                      <><Send className="w-4 h-4" /> Send Digest Now</>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
