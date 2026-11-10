package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.assistant.AssistantModels.*;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** PostgreSQL is the sole authority for conversation ownership, durable requests and results. */
@Repository
final class AssistantStore {
    record Conversation(UUID id,UUID userId,UUID meetingId,String title,String status,
                        OffsetDateTime createdAt,OffsetDateTime updatedAt) {
        ConversationView view(){return new ConversationView(id,meetingId,title,status,createdAt,updatedAt);}
    }
    record Turn(UUID id,UUID conversationId,String fingerprint,String key,UUID userMessageId,
                UUID assistantMessageId,String state,UUID token,OffsetDateTime expiresAt,String scopeVersion){}
    record Message(UUID id,UUID conversationId,String role,String content,String answerStatus,
                   String claimsJson,OffsetDateTime createdAt){}

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    AssistantStore(JdbcTemplate jdbc,ObjectMapper json){this.jdbc=jdbc;this.json=json;}

    private static Conversation conversation(ResultSet rs,int row) throws SQLException {
        return new Conversation(rs.getObject("id",UUID.class),rs.getObject("user_id",UUID.class),
            rs.getObject("meeting_id",UUID.class),rs.getString("title"),rs.getString("status"),
            rs.getObject("created_at",OffsetDateTime.class),rs.getObject("updated_at",OffsetDateTime.class));
    }
    private static Turn turn(ResultSet rs,int row) throws SQLException {
        return new Turn(rs.getObject("id",UUID.class),rs.getObject("conversation_id",UUID.class),
            rs.getString("request_sha256"),rs.getString("idempotency_key"),
            rs.getObject("user_message_id",UUID.class),rs.getObject("assistant_message_id",UUID.class),
            rs.getString("state"),rs.getObject("claim_token",UUID.class),
            rs.getObject("claim_expires_at",OffsetDateTime.class),rs.getString("scope_version"));
    }
    private static Message message(ResultSet rs,int row) throws SQLException {
        return new Message(rs.getObject("id",UUID.class),rs.getObject("conversation_id",UUID.class),
            rs.getString("role"),rs.getString("content"),rs.getString("answer_status"),
            rs.getString("answer_claims"),rs.getObject("created_at",OffsetDateTime.class));
    }
    Conversation require(UUID id,UUID actor,boolean lock) {
        List<Conversation> rows=jdbc.query("""
            SELECT id,user_id,meeting_id,title,status,created_at,updated_at
              FROM assistant_conversations WHERE id=? AND user_id=?
            """+(lock?" FOR UPDATE":""),AssistantStore::conversation,id,actor);
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        return rows.getFirst();
    }
    Conversation create(UUID id,UUID owner,UUID meeting,String title) {
        jdbc.update("""
            INSERT INTO assistant_conversations(id,user_id,meeting_id,title,status)
            VALUES (?,?,?,?,'ACTIVE')""",id,owner,meeting,title);
        return require(id,owner,false);
    }
    List<ConversationView> list(UUID actor,int page,int size) {
        return jdbc.query("""
           SELECT c.id,c.user_id,c.meeting_id,c.title,c.status,c.created_at,c.updated_at
             FROM assistant_conversations c JOIN meetings m ON m.id=c.meeting_id
            WHERE c.user_id=? AND (m.organizer_user_id=? OR EXISTS(
                 SELECT 1 FROM meeting_participants p
                  WHERE p.meeting_id=m.id AND p.user_id=? AND p.removed_at IS NULL))
            ORDER BY c.updated_at DESC,c.id DESC LIMIT ? OFFSET ?
            """, (rs,i)->conversation(rs,i).view(),actor,actor,actor,size,page*size);
    }
    Turn findTurn(UUID conversation,String key) {
        return jdbc.query("""
             SELECT id,conversation_id,request_sha256,idempotency_key,user_message_id,
                    assistant_message_id,state,claim_token,claim_expires_at,scope_version
               FROM assistant_turns WHERE conversation_id=? AND idempotency_key=? FOR UPDATE
            """,AssistantStore::turn,conversation,key).stream().findFirst().orElse(null);
    }
    Turn active(UUID conversation) {
        return jdbc.query("""
             SELECT id,conversation_id,request_sha256,idempotency_key,user_message_id,
                    assistant_message_id,state,claim_token,claim_expires_at,scope_version
               FROM assistant_turns WHERE conversation_id=? AND state='PROCESSING' FOR UPDATE
            """,AssistantStore::turn,conversation).stream().findFirst().orElse(null);
    }
    Turn findById(UUID id){
        return jdbc.query("""
             SELECT id,conversation_id,request_sha256,idempotency_key,user_message_id,
                    assistant_message_id,state,claim_token,claim_expires_at,scope_version
               FROM assistant_turns WHERE id=?
            """,AssistantStore::turn,id).stream().findFirst().orElse(null);
    }
    Turn insertTurn(UUID conversation,String key,String fingerprint,String question,String version) {
        UUID turn=UUID.randomUUID(),userMsg=UUID.randomUUID(),token=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO assistant_messages(id,conversation_id,role,content)
            VALUES (?,?,'USER',?)""",userMsg,conversation,question);
        jdbc.update("""
            INSERT INTO assistant_turns(id,conversation_id,idempotency_key,request_sha256,
                user_message_id,state,claim_token,claim_expires_at,scope_version)
            VALUES (?,?,?,?,?,'PROCESSING',?,CURRENT_TIMESTAMP+INTERVAL '120 seconds',?)
            """,turn,conversation,key,fingerprint,userMsg,token,version);
        jdbc.update("UPDATE assistant_conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?",conversation);
        return findTurn(conversation,key);
    }
    Turn reclaim(Turn old) {
        UUID token=UUID.randomUUID();
        jdbc.update("""
            UPDATE assistant_turns SET claim_token=?,claim_expires_at=CURRENT_TIMESTAMP+INTERVAL '120 seconds',
                   updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND state='PROCESSING'
            """,token,old.id());
        return findTurn(old.conversationId(),old.key());
    }
    boolean live(Turn turn){
        return turn.expiresAt()!=null && turn.expiresAt().isAfter(
            jdbc.queryForObject("SELECT CURRENT_TIMESTAMP",OffsetDateTime.class));
    }
    void expire(Turn turn) {
        if(!"PROCESSING".equals(turn.state())||live(turn))throw new IllegalStateException("Turn not expired");
        saveCompleted(turn,null,new ValidatedAnswer("FAILED","Assistant processing expired.",
            WorkerEmpty.ARRAY,WorkerEmpty.OBJECT,null,List.of(),List.of()));
    }
    void saveCompleted(Turn original,UUID expectedToken,ValidatedAnswer answer) {
        // Caller holds the conversation lock first; scope/lease fencing prevents stale results.
        Turn row=jdbc.query("""
             SELECT id,conversation_id,request_sha256,idempotency_key,user_message_id,
                    assistant_message_id,state,claim_token,claim_expires_at,scope_version
               FROM assistant_turns WHERE id=? FOR UPDATE
            """,AssistantStore::turn,original.id()).stream().findFirst().orElseThrow();
        if(!"PROCESSING".equals(row.state())
            || (expectedToken!=null && !expectedToken.equals(row.token())))
            throw new StaleTurn();
        UUID messageId=UUID.randomUUID();
        boolean failed="FAILED".equals(answer.status());
        jdbc.update("""
            INSERT INTO assistant_messages(id,conversation_id,role,content,answer_status,model_metadata,
                answer_claims,answer_diagnostics,request_id,scope_id,scope_version)
            VALUES (?,?,'ASSISTANT',?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?)
            """,messageId,row.conversationId(),answer.text(),answer.status(),
            encode(answer.provenance()),encode(answer.claims()),encode(answer.diagnostics()),
            row.id(),row.conversationId(),row.scopeVersion());
        int rank=0;
        for(CitationView citation:answer.citations()){
            rank++;
            // Only the validated, minimal provenance is persisted or displayed.
            jdbc.update("""
                INSERT INTO assistant_message_sources(assistant_message_id,citation_id,source_type,
                    source_id,meeting_id,source_revision,retrieval_chunk_id,claim_ids,citation_payload,rank)
                VALUES (?,?,?,?,?,?,?,?::jsonb,?::jsonb,?)
                """,messageId,citation.citationId(),citation.sourceType(),citation.sourceId(),
                citation.meetingId(),citation.sourceRevision(),citation.retrievalChunkId(),
                encode(citation.claimIds()),encode(citation),rank);
        }
        int changed=jdbc.update("""
            UPDATE assistant_turns SET state=?,assistant_message_id=?,claim_token=NULL,
                   claim_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND state='PROCESSING' AND claim_token=?
            """,failed?"FAILED":"COMPLETED",messageId,row.id(),row.token());
        if(changed!=1)throw new StaleTurn();
        jdbc.update("UPDATE assistant_conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?",row.conversationId());
    }
    private String encode(Object value) {
        if(value==null)return null;
        try{return json.writeValueAsString(value);}
        catch(Exception invalid){throw new IllegalStateException("Internal answer serialization failure");}
    }
    Message answer(UUID messageId) {
        if(messageId==null)return null;
        return jdbc.query("""
            SELECT id,conversation_id,role,content,answer_status,answer_claims::text AS answer_claims,created_at
              FROM assistant_messages WHERE id=?
            """,AssistantStore::message,messageId).stream().findFirst().orElse(null);
    }
    List<Message> messages(UUID conversation,int page,int size){
        List<Message> reversed=jdbc.query("""
            SELECT id,conversation_id,role,content,answer_status,answer_claims::text AS answer_claims,created_at
              FROM assistant_messages WHERE conversation_id=?
             ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?
            """,AssistantStore::message,conversation,size,page*size);
        Collections.reverse(reversed);
        return reversed;
    }
    /** Latest safe completed turns only. A previous failed or unverified answer cannot become context. */
    List<Message> context(UUID conversation,UUID currentTurn) {
        return jdbc.query("""
            SELECT m.id,m.conversation_id,m.role,m.content,m.answer_status,
                   m.answer_claims::text AS answer_claims,m.created_at
              FROM assistant_turns t JOIN assistant_messages m
                ON m.id IN (t.user_message_id,t.assistant_message_id)
             WHERE t.conversation_id=? AND t.state='COMPLETED' AND t.id<>?
             ORDER BY m.created_at DESC,m.id DESC LIMIT 12
            """,AssistantStore::message,conversation,currentTurn);
    }
    List<CitationView> citations(UUID messageId){
        if(messageId==null)return List.of();
        return jdbc.query("""
            SELECT citation_id,source_type,source_id,meeting_id,source_revision,retrieval_chunk_id,claim_ids::text
              FROM assistant_message_sources WHERE assistant_message_id=? ORDER BY rank ASC
            """,(rs,i)->new CitationView(rs.getString(1),rs.getString(2),
                rs.getObject(3,UUID.class),rs.getObject(4,UUID.class),
                rs.getLong(5),rs.getString(6),decodeStrings(rs.getString(7))),messageId);
    }
    private List<String> decodeStrings(String raw){
        try {
            JsonNode array=json.readTree(raw);
            if(!array.isArray()||array.size()>32)throw new IllegalStateException("Invalid stored citation claims");
            List<String> ids=new ArrayList<>();
            for(JsonNode v:array){if(!v.isString())throw new IllegalStateException("Invalid stored citation");ids.add(v.asString());}
            return List.copyOf(ids);
        } catch(Exception invalid){throw new IllegalStateException("Invalid canonical citation payload");}
    }
    List<ClaimView> claims(String raw){
        if(raw==null)return List.of();
        try {
            JsonNode array=json.readTree(raw);
            if(!array.isArray()||array.size()>32)throw new IllegalStateException("Invalid stored claims");
            List<ClaimView> claims=new ArrayList<>();
            for(JsonNode c:array){
                List<String> ids=new ArrayList<>();
                for(JsonNode id:c.path("citationIds")){if(!id.isString())throw new IllegalStateException();ids.add(id.asString());}
                claims.add(new ClaimView(c.path("claimId").asString(),c.path("text").asString(),
                    c.path("support").asString(),List.copyOf(ids)));
            }
            return List.copyOf(claims);
        } catch(Exception invalid){throw new IllegalStateException("Invalid canonical claims");}
    }
    static final class StaleTurn extends RuntimeException {}
    /** Valid JSON sentinels for durable terminal failure without exposing AI internals. */
    private static final class WorkerEmpty {
        static final JsonNode ARRAY=com.sme.meetingassistant.api.media.worker.WorkerJson.MAPPER.createArrayNode();
        static final JsonNode OBJECT=com.sme.meetingassistant.api.media.worker.WorkerJson.MAPPER.createObjectNode();
    }
}
