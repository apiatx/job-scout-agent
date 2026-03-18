import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  useUpdateCriteria as useGenUpdateCriteria,
  useCreateCompany as useGenCreateCompany,
  useDeleteCompany as useGenDeleteCompany,
  useUpdateJobStatus as useGenUpdateJobStatus,
  useGenerateJobDocs as useGenGenerateJobDocs,
  useUpdateResume as useGenUpdateResume,
  useRunScout as useGenRunScout,
  useDisconnectGmail as useGenDisconnectGmail,
  useSendDigestEmail as useGenSendDigestEmail,
  getGetCriteriaQueryKey,
  getListCompaniesQueryKey,
  getListJobsQueryKey,
  getGetJobQueryKey,
  getGetResumeQueryKey,
  getGetScoutStatusQueryKey,
  getGetGmailStatusQueryKey
} from "@workspace/api-client-react";

// Wrapper hooks to automatically invalidate caches on success
export function useScoutMutations() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const updateCriteria = useGenUpdateCriteria({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetCriteriaQueryKey() });
        toast({ title: "Success", description: "Criteria updated successfully." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to update criteria", variant: "destructive" })
    }
  });

  const createCompany = useGenCreateCompany({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
        toast({ title: "Company Added", description: "Target company added successfully." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to add company", variant: "destructive" })
    }
  });

  const deleteCompany = useGenDeleteCompany({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
        toast({ title: "Company Removed", description: "Company removed from targets." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to remove company", variant: "destructive" })
    }
  });

  const updateJobStatus = useGenUpdateJobStatus({
    mutation: {
      onSuccess: (data, variables) => {
        qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetJobQueryKey(variables.id) });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to update status", variant: "destructive" })
    }
  });

  const generateDocs = useGenGenerateJobDocs({
    mutation: {
      onSuccess: (data, variables) => {
        qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetJobQueryKey(variables.id) });
        toast({ title: "Documents Generated", description: "AI has tailored your resume and cover letter." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to generate docs", variant: "destructive" })
    }
  });

  const updateResume = useGenUpdateResume({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetResumeQueryKey() });
        toast({ title: "Resume Saved", description: "Your base resume has been updated." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to save resume", variant: "destructive" })
    }
  });

  const runScout = useGenRunScout({
    mutation: {
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: getGetScoutStatusQueryKey() });
        qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
        toast({ title: "Scout Started", description: data.message });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to start scout", variant: "destructive" })
    }
  });

  const disconnectGmail = useGenDisconnectGmail({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetGmailStatusQueryKey() });
        toast({ title: "Disconnected", description: "Gmail account has been disconnected." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to disconnect", variant: "destructive" })
    }
  });

  const sendDigest = useGenSendDigestEmail({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Digest Sent", description: data.message });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message || "Failed to send digest", variant: "destructive" })
    }
  });

  return {
    updateCriteria,
    createCompany,
    deleteCompany,
    updateJobStatus,
    generateDocs,
    updateResume,
    runScout,
    disconnectGmail,
    sendDigest
  };
}
