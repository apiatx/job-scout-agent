import { useState, useEffect } from "react";
import { FileText, Save, Info } from "lucide-react";
import { useGetResume } from "@workspace/api-client-react";
import { useScoutMutations } from "@/hooks/use-scout-api";
import { format } from "date-fns";

export default function Resume() {
  const { data: resume, isLoading } = useGetResume();
  const { updateResume } = useScoutMutations();
  
  const [content, setContent] = useState("");

  useEffect(() => {
    if (resume) {
      setContent(resume.content || "");
    }
  }, [resume]);

  const handleSave = () => {
    updateResume.mutate({ data: { content } });
  };

  if (isLoading) return <div className="p-8 text-center animate-pulse">Loading resume...</div>;

  return (
    <div className="space-y-6 h-full flex flex-col pb-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Base Resume</h1>
        <p className="text-muted-foreground mt-1 text-lg">Paste your full text resume here. The AI will use this as context.</p>
      </div>

      <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-200">
        <Info className="w-5 h-5 mt-0.5 shrink-0" />
        <p className="text-sm leading-relaxed">
          <strong>How it works:</strong> Paste the plain text of your entire resume (experience, education, skills). When you click "Generate Docs" on a job match, the AI will rewrite bullet points and extract the most relevant parts of this base resume to fit that specific job.
        </p>
      </div>

      <div className="flex-1 flex flex-col glass-card rounded-2xl overflow-hidden min-h-[500px]">
        <div className="p-4 border-b border-border/50 bg-secondary/30 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground font-medium">
            <FileText className="w-4 h-4" /> 
            {resume?.updatedAt ? `Last updated ${format(new Date(resume.updatedAt), 'MMM d, yyyy')}` : 'Not saved yet'}
          </div>
          <button 
            onClick={handleSave}
            disabled={updateResume.isPending || !content.trim()}
            className="flex items-center gap-2 px-6 py-2 rounded-lg font-bold bg-primary text-white shadow-lg hover:shadow-primary/30 transition-all disabled:opacity-50"
          >
            <Save className="w-4 h-4" /> {updateResume.isPending ? "Saving..." : "Save Resume"}
          </button>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste your resume text here..."
          className="flex-1 w-full p-6 bg-transparent resize-none outline-none text-foreground/90 font-mono text-sm leading-relaxed placeholder:text-muted-foreground/50"
          spellCheck="false"
        />
      </div>
    </div>
  );
}
