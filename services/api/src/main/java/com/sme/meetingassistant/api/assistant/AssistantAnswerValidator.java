package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.assistant.AssistantModels.CitationView;
import com.sme.meetingassistant.api.assistant.AssistantModels.ClaimView;
import com.sme.meetingassistant.api.assistant.AssistantModels.ValidatedAnswer;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;

/** Treat the entire AI response as untrusted, including scope identity and cited provenance. */
final class AssistantAnswerValidator {
    static final int MAX_BYTES=256*1024;
    private static final Pattern CITATION=Pattern.compile("C[1-9][0-9]{0,2}");
    private static final Pattern CLAIM=Pattern.compile("A[1-9][0-9]{0,2}");
    private static final Set<String> TYPES=Set.of("TRANSCRIPT","SUMMARY","DECISION","ACTION_ITEM");
    private static final Set<String> STATUSES=Set.of("GROUNDED","PARTIAL","INSUFFICIENT_EVIDENCE","FAILED");
    private static final Set<String> SUPPORTS=Set.of("SUPPORTED","UNSUPPORTED","CONFLICTED");
    private final AssistantSourceVerifier sources;
    AssistantAnswerValidator(AssistantSourceVerifier sources) { this.sources=sources; }

    ValidatedAnswer validate(String raw, UUID requestId, UUID scopeId, String scopeVersion, UUID meetingId) {
        try { return decode(raw,requestId,scopeId,scopeVersion,meetingId); }
        catch (RuntimeException invalid) { throw new InvalidAnswer(); }
    }

    private ValidatedAnswer decode(String raw,UUID requestId,UUID scopeId,String scopeVersion,UUID meetingId) {
        if (raw==null) throw new InvalidAnswer();
        JsonNode root=WorkerJson.parse(raw.getBytes(StandardCharsets.UTF_8),MAX_BYTES);
        if (!"1.0".equals(WorkerJson.string(root,"contractVersion",8))
            || !requestId.toString().equals(WorkerJson.string(root,"requestId",128))) throw new InvalidAnswer();
        String status=WorkerJson.string(root,"status",32);
        if (!STATUSES.contains(status)) throw new InvalidAnswer();
        JsonNode claims=WorkerJson.array(root,"claims",0,32);
        JsonNode citations=WorkerJson.array(root,"citations",0,64);
        JsonNode diag=root.get("diagnostics");
        if (diag==null||!diag.isObject()) throw new InvalidAnswer();
        JsonNode provenance=root.get("modelProvenance");
        if(provenance!=null&&!provenance.isNull()&&!provenance.isObject()) throw new InvalidAnswer();
        JsonNode answer=root.get("answer");
        String text=(answer==null||answer.isNull())?null:WorkerJson.string(root,"answer",20000);
        JsonNode failures=WorkerJson.array(root,"failures",0,8);
        if ("FAILED".equals(status)) {
            if(text!=null||claims.size()!=0||citations.size()!=0||failures.isEmpty())
                throw new InvalidAnswer();
            for(JsonNode failure:failures) {
                if(!failure.isObject()||!failure.path("category").isString()
                        ||!failure.path("code").isString()||!failure.path("retryable").isBoolean()
                        ||!failure.path("message").isString()) throw new InvalidAnswer();
            }
            return new ValidatedAnswer("FAILED","Assistant is temporarily unavailable.",
                claims,diag,null,List.of(),List.of());
        }
        if(!scopeId.toString().equals(WorkerJson.string(root,"scopeId",36))
            || !scopeVersion.equals(WorkerJson.string(root,"scopeVersion",128))
            || !failures.isEmpty()) throw new InvalidAnswer();
        if (text==null) throw new InvalidAnswer();
        if("INSUFFICIENT_EVIDENCE".equals(status)) {
            if(!claims.isEmpty()||!citations.isEmpty()||(provenance!=null&&!provenance.isNull()))
                throw new InvalidAnswer();
            return new ValidatedAnswer(status,text,claims,diag,null,List.of(),List.of());
        }
        if(claims.isEmpty()||provenance==null||!provenance.isObject()) throw new InvalidAnswer();
        if(!provenance.path("provider").isString()||!provenance.path("configuredModel").isString()
                ||!provenance.path("attempts").isIntegralNumber()) throw new InvalidAnswer();
        Map<String,CitationView> byId=new LinkedHashMap<>();
        int rank=0;
        for(JsonNode citation:citations) {
            rank++;
            String id=WorkerJson.string(citation,"citationId",8);
            if (!CITATION.matcher(id).matches()||byId.containsKey(id)
                    ||!"AUTHORITATIVELY_VERIFIED".equals(WorkerJson.string(citation,"verificationStatus",64)))
                throw new InvalidAnswer();
            JsonNode identity=citation.get("sourceIdentity");
            if(identity==null||!identity.isObject()) throw new InvalidAnswer();
            String type=WorkerJson.string(identity,"sourceType",32);
            if (!TYPES.contains(type)) throw new InvalidAnswer();
            UUID source=WorkerJson.uuid(identity,"sourceId");
            UUID actualMeeting=WorkerJson.uuid(identity,"meetingId");
            if(!actualMeeting.equals(meetingId)) throw new InvalidAnswer();
            JsonNode revisionNode=citation.get("sourceRevision");
            long revision=WorkerJson.number(revisionNode,"number",0,Long.MAX_VALUE);
            String chunk=WorkerJson.string(citation,"retrievalChunkId",128);
            JsonNode refs=WorkerJson.array(citation,"sourceReferences",1,64);
            for(JsonNode ref:refs) {
                JsonNode sourceIdentity=ref.get("sourceIdentity");
                JsonNode sourceRevision=ref.get("sourceRevision");
                if(sourceIdentity==null||!sourceIdentity.isObject()||sourceRevision==null||!sourceRevision.isObject()
                    ||!type.equals(WorkerJson.string(sourceIdentity,"sourceType",32))
                    ||!source.equals(WorkerJson.uuid(sourceIdentity,"sourceId"))
                    ||!meetingId.equals(WorkerJson.uuid(sourceIdentity,"meetingId"))
                    ||revision!=WorkerJson.number(sourceRevision,"number",0,Long.MAX_VALUE))
                    throw new InvalidAnswer();
            }
            if(!sources.current(type,source,meetingId,revision)) throw new InvalidAnswer();
            byId.put(id,new CitationView(id,type,source,meetingId,revision,chunk,List.of()));
        }
        Map<String,List<String>> usage=new LinkedHashMap<>();
        for(String id:byId.keySet())usage.put(id,new ArrayList<>());
        Set<String> seenClaims=new HashSet<>();
        List<ClaimView> safeClaims=new ArrayList<>();
        boolean hasSupported=false,hasUnsupported=false;
        for(JsonNode claim:claims) {
            String id=WorkerJson.string(claim,"claimId",8);
            String body=WorkerJson.string(claim,"text",4000);
            String support=WorkerJson.string(claim,"support",32);
            if(!CLAIM.matcher(id).matches()||!seenClaims.add(id)||!SUPPORTS.contains(support))
                throw new InvalidAnswer();
            JsonNode claimCitationIds=WorkerJson.array(claim,"citationIds",0,8);
            List<String> ids=new ArrayList<>();
            for(JsonNode value:claimCitationIds) {
                if(!value.isString())throw new InvalidAnswer();
                String citationId=value.asString();
                if(!usage.containsKey(citationId)||ids.contains(citationId))throw new InvalidAnswer();
                ids.add(citationId);
                usage.get(citationId).add(id);
            }
            if("UNSUPPORTED".equals(support)) {
                hasUnsupported=true;
                if(!ids.isEmpty())throw new InvalidAnswer();
            } else {
                hasSupported=true;
                if(ids.isEmpty()||("CONFLICTED".equals(support)&&ids.size()<2))throw new InvalidAnswer();
            }
            safeClaims.add(new ClaimView(id,body,support,List.copyOf(ids)));
        }
        if(!hasSupported||("GROUNDED".equals(status)&&hasUnsupported)
            ||("PARTIAL".equals(status)&&!hasUnsupported
                && safeClaims.stream().noneMatch(c->"CONFLICTED".equals(c.support())))
            ||usage.values().stream().anyMatch(List::isEmpty))throw new InvalidAnswer();
        List<CitationView> safeCitations=new ArrayList<>();
        for(var entry:byId.entrySet()){
            var c=entry.getValue();
            safeCitations.add(new CitationView(c.citationId(),c.sourceType(),c.sourceId(),c.meetingId(),
                c.sourceRevision(),c.retrievalChunkId(),List.copyOf(usage.get(entry.getKey()))));
        }
        return new ValidatedAnswer(status,text,claims,diag,provenance,
            List.copyOf(safeCitations),List.copyOf(safeClaims));
    }
    static final class InvalidAnswer extends RuntimeException {
        InvalidAnswer() {super("Assistant result did not satisfy canonical validation");}
    }
}
