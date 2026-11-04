package com.sme.meetingassistant.api.media.worker;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Fully validated corrected-only mapping; exact text is never normalized. */
public record CorrectedTranscript(UUID jobId,UUID mediaId,String sourceRevision,UUID producerId,
        String language,long sampleCount,long duration,List<SegmentResult> segments,List<CoverageResult> coverage,
        Status status,String correctionDigest,String promptVersion,int warningCount,JsonNode metadata) {
    public static final int MAX_BYTES=8388608;
    // Pinned to Worker V1 / workers/transcription.py _WARNING_CODES (pipeline baseline).
    private static final Set<String> CHUNKS=Set.of("candidate-evidence","missing","failed","empty","malformed");
    private static final Map<String,Set<String>> WARNINGS=Map.of(
        "PREPROCESSING",Set.of("weak-speech","uncertain-vad","vad-energy-disagreement","high-energy-non-speech","protected-window-coalescing"),
        "CHUNK_PLANNING",Set.of(),"ASR",CHUNKS,
        "COVERAGE_RECOVERY",Set.of("missing-speech","failed-chunk","malformed-chunk","missing-chunk-result","uncertain-vad","non-speech-vad",
            "protected-only","unsupported-candidate","missing-text-support","repeated-non-overlap-text","low-confidence","weak-speech",
            "high-energy-non-speech","vad-energy-disagreement","neighboring-gap","duplicate-overlap","tolerated-map-artifact",
            "missing-canonical-text","raw-only-support","canonical-conflict","ambiguous-reconciliation","canonical-acoustic-disagreement",
            "skipped-by-asr-strategy","sufficient-coverage","no-actionable-regions","no-distinct-window","no-progress","terminal-failure",
            "region-attempt-limit","region-sample-limit","total-attempt-limit","total-sample-limit","wall-time-limit",
            "no-admissible-improvement","canonical-regression-prevented","validation","resource","provider","transport","timeout",
            "authentication","rate_limit","malformed_output","unresolved-speech"),
        "RECONCILIATION",Set.of("candidate-evidence","missing","failed","empty","malformed","duplicate-overlap","conflicting-overlap","unresolved-boundary","unresolved-interval"),
        "CORRECTION",Set.of("completed-with-warnings","empty-transcript"));

    public static CorrectedTranscript validate(byte[] bytes,UUID job,UUID media,String revision,UUID producer,String expectedDigest) {
        if (!sha256(bytes).equals(expectedDigest)) throw WorkerException.invalid();
        try {
            var n=parse(bytes,MAX_BYTES);
            fields(n,"contractVersion","resultType","processingJobId","sourceMediaId","sourceRevision","producerStageRunId",
                "pipelineStatus","languageCode","sampleRateHz","sampleCount","durationMs","segments","coverage","warnings","provenance","correctionProof");
            require("1.0".equals(string(n,"contractVersion",16)));
            choice(n,"resultType","CORRECTED_TRANSCRIPT");
            require(uuid(n,"processingJobId").equals(job) && uuid(n,"sourceMediaId").equals(media)
                && digest(n,"sourceRevision").equals(revision) && uuid(n,"producerStageRunId").equals(producer));
            String pipeline=choice(n,"pipelineStatus","COMPLETED","COMPLETED_WITH_WARNINGS");
            String language=token(n,"languageCode",16);
            number(n,"sampleRateHz",16000,16000);
            long samples=number(n,"sampleCount",1,230400000), duration=number(n,"durationMs",1,14400000);
            require(duration==(samples*1000+15999)/16000);
            var segments=new ArrayList<SegmentResult>(); long previous=-1;
            var wireSegments=array(n,"segments",0,16384);
            if(wireSegments.isEmpty()) throw new WorkerException(422,"TRANSCRIPTION_EMPTY");
            for(var s:wireSegments) {
                fields(s,"ordinal","startMs","endMs","text","qualityStatus");
                int ordinal=(int)number(s,"ordinal",0,16383); require(ordinal==segments.size());
                long start=number(s,"startMs",0,duration-1),end=number(s,"endMs",start+1,duration);
                require(start>=previous); previous=start;
                segments.add(new SegmentResult(ordinal,start,end,string(s,"text",20000),
                    choice(s,"qualityStatus","ACCEPTED","SUSPICIOUS","UNRESOLVED"),null,null,null));
            }
            var coverage=new ArrayList<CoverageResult>(); previous=-1;
            for(var c:array(n,"coverage",1,65536)) {
                fields(c,"startMs","endMs","coverageStatus","recovered","retryCount");
                long start=number(c,"startMs",0,duration-1),end=number(c,"endMs",start+1,duration);
                require(start>=previous); previous=start;
                boolean recovered=bool(c,"recovered"); int retries=(int)number(c,"retryCount",0,Integer.MAX_VALUE);
                require(!recovered || retries>0);
                coverage.add(new CoverageResult(start,end,choice(c,"coverageStatus","COVERED","SUSPICIOUS","UNRESOLVED_ERROR"),recovered,retries,null));
            }
            var all=new Intervals(coverage.stream().map(c->new long[]{c.startMs(),c.endMs()}).toList());
            var unresolved=new Intervals(coverage.stream().filter(c->c.coverageStatus().equals("UNRESOLVED_ERROR")).map(c->new long[]{c.startMs(),c.endMs()}).toList());
            var suspicious=new Intervals(coverage.stream().filter(c->c.coverageStatus().equals("SUSPICIOUS")).map(c->new long[]{c.startMs(),c.endMs()}).toList());
            var accepted=new Intervals(segments.stream().filter(s->s.qualityStatus().equals("ACCEPTED")).map(s->new long[]{s.startMs(),s.endMs()}).toList());
            for(var s:segments) {
                require(all.intersects(s.startMs(),s.endMs()));
                require(!unresolved.intersects(s.startMs(),s.endMs()) || s.qualityStatus().equals("UNRESOLVED"));
                require(!suspicious.intersects(s.startMs(),s.endMs()) || !s.qualityStatus().equals("ACCEPTED"));
            }
            for(var c:coverage) require(!c.coverageStatus().equals("COVERED") || accepted.intersects(c.startMs(),c.endMs()));
            var warnings=array(n,"warnings",0,4096);
            for(var w:warnings) validateWarning(w,samples);
            // Reconciliation flags are final evidence, unlike retained initial recovery warnings.
            for(var w:warnings) {
                if(!w.get("stage").asString().equals("RECONCILIATION") || w.get("startSample").isNull()) continue;
                String code=w.get("code").asString();
                boolean unresolvedWarning=code.equals("unresolved-interval");
                boolean flaggedWarning=Set.of("duplicate-overlap","conflicting-overlap","unresolved-boundary").contains(code);
                if(!unresolvedWarning && !flaggedWarning) continue;
                long start=w.get("startSample").longValue()*1000/16000;
                long end=(w.get("endSample").longValue()*1000+15999)/16000;
                for(var s:segments) {
                    if(s.startMs()>=end) break;
                    if(start<s.endMs()) require(unresolvedWarning?s.qualityStatus().equals("UNRESOLVED"):!s.qualityStatus().equals("ACCEPTED"));
                }
            }
            validateProvenance(n.get("provenance"));
            var proof=n.get("correctionProof"); fields(proof,"contextScope","promptVersion","outputSha256");
            choice(proof,"contextScope","WHOLE_MEETING");
            String prompt=string(proof,"promptVersion",80); require(prompt.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,79}"));
            String correction=digest(proof,"outputSha256");
            boolean flagged=!warnings.isEmpty() || segments.stream().anyMatch(s->!s.qualityStatus().equals("ACCEPTED"))
                || coverage.stream().anyMatch(c->!c.coverageStatus().equals("COVERED"));
            require(pipeline.equals("COMPLETED_WITH_WARNINGS")==flagged);
            var result=new CorrectedTranscript(job,media,revision,producer,language,samples,duration,List.copyOf(segments),List.copyOf(coverage),
                flagged?Status.READY_WITH_WARNINGS:Status.READY,correction,prompt,warnings.size(),
                MAPPER.createObjectNode().set("warnings",warnings).set("provenance",n.get("provenance")).set("correctionProof",proof));
            require(TranscriptCorrectionDigest.sha256(result.mapping(null,null)).equals(correction));
            return result;
        } catch(WorkerException e) {
            if(e.code().equals("TRANSCRIPTION_EMPTY") || e.status()==413) throw e;
            throw WorkerException.invalid();
        } catch(Exception e) { throw WorkerException.invalid(); }
    }
    public TranscriptResult mapping(UUID meeting,UUID finalization) {
        return new TranscriptResult(meeting,mediaId,jobId,finalization,language,duration,status,
            segments.stream().map(s->new SegmentResult(s.ordinal(),s.startMs(),s.endMs(),s.text(),s.qualityStatus(),null,finalization,null)).toList(),coverage,List.of(),warningCount);
    }
    public String proofJson() { return metadata.get("correctionProof").toString(); }
    private static void validateWarning(JsonNode w,long samples) {
        fields(w,"stage","code","startSample","endSample","sourceChunkIds","phase");
        String stage=string(w,"stage",32),code=string(w,"code",80);
        require(WARNINGS.containsKey(stage) && WARNINGS.get(stage).contains(code));
        require(w.get("startSample").isNull()==w.get("endSample").isNull());
        if(!w.get("startSample").isNull()) {
            long start=number(w,"startSample",0,samples-1); number(w,"endSample",start+1,samples);
        }
        if(!w.get("phase").isNull()) choice(w,"phase","initial","final","attempt");
        for(var id:array(w,"sourceChunkIds",0,64)) {
            var wrapper=MAPPER.createObjectNode().set("id",id); token(wrapper,"id",128);
        }
    }
    private static void validateProvenance(JsonNode p) {
        fields(p,"pipelineVersion","configurationSha256","components","vadModel","models");
        token(p,"pipelineVersion",80); digest(p,"configurationSha256");
        var names=new HashSet<String>();
        for(var c:array(p,"components",1,16)) {
            fields(c,"name","version"); require(names.add(token(c,"name",128))); token(c,"version",80);
        }
        var vad=p.get("vadModel"); fields(vad,"modelId","modelVersion","sha256");
        token(vad,"modelId",256); token(vad,"modelVersion",80); digest(vad,"sha256");
        var models=new HashSet<String>(); boolean correction=false;
        for(var m:array(p,"models",1,64)) {
            fields(m,"role","provider","requestedModel","resolvedModel");
            correction|=choice(m,"role","ASR","CORRECTION").equals("CORRECTION");
            token(m,"provider",80); token(m,"requestedModel",256);
            if(!m.get("resolvedModel").isNull()) token(m,"resolvedModel",256);
            require(models.add(m.get("role").toString()+m.get("provider")+m.get("requestedModel")+m.get("resolvedModel")));
        }
        require(correction);
    }
    /** Prefix maxima give bounded O(log n) overlap checks even for genuine overlapping intervals. */
    private static final class Intervals {
        private final long[] starts,ends;
        Intervals(List<long[]> items) {
            starts=new long[items.size()]; ends=new long[items.size()]; long max=-1;
            for(int i=0;i<items.size();i++) { starts[i]=items.get(i)[0]; max=Math.max(max,items.get(i)[1]); ends[i]=max; }
        }
        boolean intersects(long start,long end) {
            int low=0,high=starts.length;
            while(low<high) { int mid=(low+high)>>>1; if(starts[mid]<end) low=mid+1; else high=mid; }
            return low>0 && ends[low-1]>start;
        }
    }
    @Override public String toString() { return "CorrectedTranscript[validated,redacted]"; }
}
