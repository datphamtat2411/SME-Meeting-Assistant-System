package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.assistant.AssistantModels.*;
import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.*;
import java.util.regex.Pattern;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.env.Environment;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/** Core-owned admission and result acceptance. Slow inference runs outside DB transactions. */
@Service
public final class AssistantService {
    private static final Pattern KEY=Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private final AssistantStore store;
    private final AssistantAdmissionGuard admission;
    private final MeetingMediaAccess access;
    private final OrganizationalAuthorizationService identity;
    private final AssistantSourceVerifier sources;
    private final AssistantAnswerValidator answers;
    private final AssistantEvidenceResolver evidenceResolver;
    private final ObjectProvider<AssistantAiGateway> gateway;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final boolean enabled;

    AssistantService(AssistantStore store,AssistantAdmissionGuard admission,MeetingMediaAccess access,
            OrganizationalAuthorizationService identity,AssistantSourceVerifier sources,
            AssistantEvidenceResolver evidenceResolver,ObjectProvider<AssistantAiGateway> gateway,ObjectMapper json,
            PlatformTransactionManager transactions,Environment env) {
        this.store=store;this.admission=admission;this.access=access;this.identity=identity;this.sources=sources;
        this.answers=new AssistantAnswerValidator(sources);this.evidenceResolver=evidenceResolver;
        this.gateway=gateway;this.json=json;
        this.tx=new TransactionTemplate(transactions);
        this.enabled=env.getProperty("app.assistant.enabled",Boolean.class,false);
        if(enabled && gateway.getIfAvailable()==null)
            throw new IllegalStateException("Assistant enabled without authenticated AI transport");
    }

    private void requireEnabled(){
        if(!enabled)throw new AssistantDomainException(HttpStatus.SERVICE_UNAVAILABLE,
            "ASSISTANT_UNAVAILABLE","Assistant capability is disabled.");
    }
    private UUID actor(){return identity.requireActiveActor().getId();}

    private <T> T readWithAvailability(Supplier<T> operation){
        try {
            return operation.get();
        } catch (DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        }
    }

    private static AssistantDomainException unavailable(){
        return new AssistantDomainException(HttpStatus.SERVICE_UNAVAILABLE,
            "ASSISTANT_UNAVAILABLE","Assistant state is temporarily unavailable.");
    }

    ConversationView create(CreateConversation input) {
        requireEnabled();
        UUID user;
        try {
            user=actor();
        } catch (DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        }
        if(input==null||input.meetingId()==null)throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        String title=input.title()==null||input.title().isBlank()?null:input.title().trim();
        try {
            access.requireReadable(input.meetingId(),user);
        } catch (DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        }
        ConversationView created;
        try {
            created=tx.execute(s->{
                admission.lockConversationCreationScope(user);
                access.requireReadable(input.meetingId(),user);
                admission.ensureConversationCreationQuota(user);
                var saved=store.create(UUID.randomUUID(),user,input.meetingId(),title);
                admission.recordConversationCreation(user,saved.id());
                return saved.view();
            });
        } catch (DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        }
        access.requireReadable(input.meetingId(),user);
        return created;
    }

    List<ConversationView> list(int page,int size){
        requireEnabled();validatePage(page,size);
        return readWithAvailability(()->store.list(actor(),page,size));
    }


    ConversationDetail detail(UUID id,int page,int size){
        return detail(id,page,size,null);
    }

    ConversationDetail detail(UUID id,Integer page,int size,UUID beforeMessageId){
        requireEnabled();
        return readWithAvailability(()->readDetail(id,page,size,beforeMessageId));
    }

    private ConversationDetail readDetail(UUID id,Integer page,int size,UUID beforeMessageId){
        UUID user=actor();
        if(page!=null&&beforeMessageId!=null)
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        int requestedPage=page==null?0:page;
        validatePage(requestedPage,size);
        var conversation=store.require(id,user,false);
        access.requireReadable(conversation.meetingId(),user);
        List<AssistantStore.Message> messages=beforeMessageId==null
            ?store.messages(id,requestedPage*size,size+1)
            :store.messagesBefore(id,beforeMessageId,size+1);
        boolean hasMore=messages.size()>size;
        if(hasMore)messages=messages.subList(messages.size()-size,messages.size());
        List<MessageView> views=new ArrayList<>();
        for(var message:messages)views.add(view(message,conversation.meetingId()));
        UUID next=hasMore?messages.getFirst().id():null;
        var pending=store.observePending(id);
        TurnStatusView pendingView=pending==null?null:statusView(conversation,pending);
        access.requireReadable(conversation.meetingId(),user);
        return new ConversationDetail(conversation.view(),List.copyOf(views),requestedPage,size,hasMore,next,pendingView);
    }

    MessageEvidence evidence(UUID conversationId,UUID messageId){
        requireEnabled();
        return readWithAvailability(()->tx.execute(status->{
            UUID user=actor();
            var conversation=store.require(conversationId,user,false);
            UUID meeting=conversation.meetingId();
            access.requireReadable(meeting,user);
            // Serialize with source changes using the existing evidence lock.
            store.lockMeetingForEvidence(meeting);
            access.requireReadable(meeting,user);
            var message=store.answer(messageId);
            if(message==null||!conversationId.equals(message.conversationId())||!"ASSISTANT".equals(message.role()))
                throw new AssistantDomainException(HttpStatus.NOT_FOUND,"ASSISTANT_MESSAGE_NOT_FOUND",
                    "Assistant message was not found.");
            List<CitationView> citations=store.citations(messageId);
            boolean grounded="GROUNDED".equals(message.answerStatus())||"PARTIAL".equals(message.answerStatus());
            if(citations.size()>64||grounded==citations.isEmpty())
                throw AssistantEvidenceResolver.stale();
            List<EvidenceView> evidence=evidenceResolver.resolve(meeting,user,citations);
            access.requireReadable(meeting,user);
            return new MessageEvidence(conversationId,messageId,meeting,evidence);
        }));
    }

    TurnStatusView observe(UUID conversationId,UUID turnId,String key){
        requireEnabled();
        return readWithAvailability(()->readTurnStatus(conversationId,turnId,key));
    }

    private TurnStatusView readTurnStatus(UUID conversationId,UUID turnId,String key){
        UUID user=actor();
        var conversation=store.require(conversationId,user,false);
        access.requireReadable(conversation.meetingId(),user);
        if(turnId==null&&(key==null||!KEY.matcher(key).matches()))
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        var turn=turnId==null?store.observeByKey(conversationId,key):store.findById(turnId);
        if(turn==null||!conversationId.equals(turn.conversationId()))
            throw turnNotFound();
        TurnStatusView result=statusView(conversation,turn);
        access.requireReadable(conversation.meetingId(),user);
        return result;
    }

    private TurnStatusView statusView(AssistantStore.Conversation conversation,AssistantStore.Turn turn){
        String state=turn.state();
        if("PROCESSING".equals(state))
            return new TurnStatusView(conversation.id(),turn.id(),state,
                store.live(turn)?"ACTIVE":"EXPIRED",turn.userMessageId(),null,null);
        var message=store.answer(turn.assistantMessageId());
        if(message==null||!conversation.id().equals(message.conversationId()))
            throw unavailable();
        if("COMPLETED".equals(state)&&!"VISIBLE".equals(view(message,conversation.meetingId()).visibility()))
            state="STALE_SOURCE";
        return new TurnStatusView(conversation.id(),turn.id(),state,null,turn.userMessageId(),
            message.id(),message.answerStatus());
    }

    /**
     * Explicit recovery uses the persisted question and key, never browser state.
     * The reservation transaction must still find this exact durable turn.
     */
    TurnOutcome recover(UUID conversationId,UUID turnId){
        requireEnabled();
        return readWithAvailability(()->{
            UUID user=actor();
            var conversation=store.require(conversationId,user,false);
            access.requireReadable(conversation.meetingId(),user);
            var turn=store.findById(turnId);
            if(turn==null||!conversationId.equals(turn.conversationId()))
                throw turnNotFound();
            var question=store.answer(turn.userMessageId());
            if(question==null||!conversationId.equals(question.conversationId())
                ||!"USER".equals(question.role())||question.content()==null
                ||!turn.fingerprint().equals(WorkerJson.sha256(question.content().getBytes(StandardCharsets.UTF_8))))
                throw unavailable();
            return submit(conversationId,turn.key(),new Ask(question.content()),turnId);
        });
    }

    private static AssistantDomainException turnNotFound(){
        return new AssistantDomainException(HttpStatus.NOT_FOUND,"ASSISTANT_TURN_NOT_FOUND",
            "Assistant turn was not found.");
    }

    TurnOutcome submit(UUID conversationId,String idempotencyKey,Ask input){
        return submit(conversationId,idempotencyKey,input,null);
    }

    private TurnOutcome submit(UUID conversationId,String idempotencyKey,Ask input,UUID expectedTurnId){
        requireEnabled();
        UUID user;
        try {
            user=actor();
        } catch (DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        }
        if(input==null||input.question()==null||input.question().isBlank()
            ||idempotencyKey==null||!KEY.matcher(idempotencyKey).matches())
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        String question=input.question().trim();
        if(question.isBlank()||question.codePointCount(0,question.length())>4096)
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        String fingerprint=WorkerJson.sha256(question.getBytes(StandardCharsets.UTF_8));
        AssistantStore.Conversation conversation;
        try {
            conversation=store.require(conversationId,user,false);
            access.requireReadable(conversation.meetingId(),user);
        } catch (DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        }
        Admission admitted;
        long admissionStarted=System.nanoTime();
        try {
            admitted=tx.execute(s->reserve(conversationId,user,idempotencyKey,question,fingerprint,
                conversation.meetingId(),expectedTurnId));
        } catch (DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        } finally {
            admission.latency("ASK",System.nanoTime()-admissionStarted);
        }
        if(!admitted.execute()) {
            return readWithAvailability(()->{
                access.requireReadable(conversation.meetingId(),user);
                return outcome(admitted.turn(),conversation.meetingId());
            });
        }

        ValidatedAnswer reply;
        try {
            // Context failures are also terminalized, rather than stranding a leased turn.
            // Only committed dialogue with CURRENT evidence may enter the LLM context.
            List<Map<String,Object>> context=safeContext(conversation.meetingId(),admitted.turn());
            String payload=request(conversation,user,admitted.turn(),question,context);
            String raw=gateway.getObject().answer(payload);
            access.requireReadable(conversation.meetingId(),user);
            reply=answers.validate(raw,admitted.turn().id(),conversation.id(),
                admitted.turn().scopeVersion(),conversation.meetingId());
        } catch(ResponseStatusException revoked) {
            markFailed(conversationId,user,admitted.turn());
            throw revoked;
        } catch(DataAccessException|TransactionException unavailable) {
            // Do not turn a Core persistence outage into an AI call or a
            // synthetic FAILED answer. The durable lease will recover it.
            throw admission.databaseUnavailable();
        } catch(Exception invalidOrUnavailable) {
            // Provider exceptions, credentials, text and raw responses are never returned or logged.
            reply=failed();
        }
        final ValidatedAnswer accepted=reply;
        try {
            tx.execute(s->{
                // The meeting row is the serialization point shared with transcript,
                // summary and decision writers. A source revision cannot change
                // between revalidation and persistence of the canonical answer.
                store.lockMeetingForEvidence(conversation.meetingId());
                var current=store.require(conversationId,user,true);
                access.requireReadable(current.meetingId(),user);
                ValidatedAnswer toPersist=accepted;
                for(CitationView citation:accepted.citations()){
                    if(!citation.meetingId().equals(current.meetingId())
                        ||!sources.current(citation.sourceType(),citation.sourceId(),
                            current.meetingId(),citation.sourceRevision())){
                        toPersist=failed(); // fail closed: never persist an obsolete grounded answer
                        break;
                    }
                }
                store.saveCompleted(admitted.turn(),admitted.turn().token(),toPersist);
                return null;
            });
        } catch(ResponseStatusException revoked) {
            markFailed(conversationId,user,admitted.turn());
            throw revoked;
        } catch(AssistantStore.StaleTurn stale) {
            // Another owner may already have finalized the turn. Read the
            // canonical outcome; never return the obsolete inference result.
        } catch(DataAccessException|TransactionException unavailable) {
            throw admission.databaseUnavailable();
        }
        return readWithAvailability(()->{
            access.requireReadable(conversation.meetingId(),user);
            return outcome(store.findById(admitted.turn().id()),conversation.meetingId());
        });
    }

    private void markFailed(UUID conversationId,UUID user,AssistantStore.Turn requested) {
        tx.execute(s->{
            store.require(conversationId,user,true);
            var current=store.findById(requested.id());
            if(current!=null&&"PROCESSING".equals(current.state())
                    &&requested.token().equals(current.token()))
                store.saveCompleted(current,current.token(),failed());
            return null;
        });
    }

    private Admission reserve(UUID conversationId,UUID user,String key,String question,
            String fingerprint,UUID expectedMeeting,UUID expectedTurnId){
        // The transaction-local timeout covers the conversation row and every
        // later advisory lock without changing the pooled session.
        admission.configureLockWaitTimeout();
        var conversation=admission.lockConversation(
            () -> store.require(conversationId,user,true));
        if(!conversation.meetingId().equals(expectedMeeting))
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        access.requireReadable(conversation.meetingId(),user);
        if(!"ACTIVE".equals(conversation.status()))throw new AssistantDomainException(HttpStatus.CONFLICT,
            "ASSISTANT_CONVERSATION_INACTIVE","Assistant conversation is inactive.");
        AssistantStore.Turn prior=store.findTurn(conversationId,key);
        if(expectedTurnId!=null&&(prior==null||!expectedTurnId.equals(prior.id())))
            throw turnNotFound(); // recovery can never insert a replacement turn
        if(prior!=null){
            if(!prior.fingerprint().equals(fingerprint))
                throw new AssistantDomainException(HttpStatus.CONFLICT,"ASSISTANT_IDEMPOTENCY_CONFLICT",
                    "Idempotency key reused with different question.");
            if(!"PROCESSING".equals(prior.state())){
                admission.replay();
                return new Admission(prior,false);
            }
            if(store.live(prior)){
                admission.replay();
                return new Admission(prior,false);
            }
            admission.lockAskLocalScopes(user,conversation.meetingId());
            admission.ensureScopedActiveCapacity(user,conversation.meetingId());
            admission.lockAskGlobalScope();
            admission.ensureGlobalActiveCapacity();
            var reclaimed=store.reclaim(prior);
            admission.leaseReclaimed();
            return new Admission(reclaimed,true);
        }
        AssistantStore.Turn busy=store.active(conversationId);
        if(busy!=null){
            if(store.live(busy))throw new AssistantDomainException(HttpStatus.CONFLICT,
                "ASSISTANT_TURN_IN_PROGRESS","A previous Assistant turn is still processing.");
            store.expire(busy);
            admission.leaseExpired();
        }
        admission.lockAskLocalScopes(user,conversation.meetingId());
        admission.ensureAskQuota(user);
        admission.ensureScopedActiveCapacity(user,conversation.meetingId());
        admission.lockAskGlobalScope();
        admission.ensureGlobalActiveCapacity();
        var inserted=store.insertTurn(conversationId,key,fingerprint,question,
            version(conversation.meetingId(),user));
        admission.recordAsk(user,inserted.id());
        return new Admission(inserted,true);
    }

    private TurnOutcome outcome(AssistantStore.Turn turn,UUID meeting){
        if(turn==null)throw unavailable();
        if("PROCESSING".equals(turn.state()))
            return new TurnOutcome(202,new TurnView(turn.id(),"PROCESSING",turn.userMessageId(),
                null,null,null,List.of(),List.of()));
        AssistantStore.Message msg=store.answer(turn.assistantMessageId());
        if(msg==null)throw unavailable();
        if("FAILED".equals(turn.state()))
            return new TurnOutcome(503,new TurnView(turn.id(),"FAILED",turn.userMessageId(),
                msg.id(),"FAILED",null,List.of(),List.of()));
        MessageView display=view(msg,meeting);
        if(!"VISIBLE".equals(display.visibility()))
            return new TurnOutcome(409,new TurnView(turn.id(),"STALE_SOURCE",turn.userMessageId(),
                msg.id(),msg.answerStatus(),null,List.of(),List.of()));
        return new TurnOutcome(200,new TurnView(turn.id(),"COMPLETED",turn.userMessageId(),
            msg.id(),msg.answerStatus(),display.content(),display.claims(),display.citations()));
    }

    private MessageView view(AssistantStore.Message msg,UUID meeting){
        List<CitationView> citations=store.citations(msg.id());
        List<ClaimView> claims=store.claims(msg.claimsJson());
        String visibility="VISIBLE",content=msg.content();
        if("GROUNDED".equals(msg.answerStatus())||"PARTIAL".equals(msg.answerStatus())){
            boolean ok=!citations.isEmpty();
            for(CitationView citation:citations){
                if(!citation.meetingId().equals(meeting)){ok=false;break;}
                try {
                    if(!sources.current(citation.sourceType(),citation.sourceId(),meeting,
                        citation.sourceRevision())){ok=false;break;}
                } catch(RuntimeException unavailable){ok=false;break;}
            }
            if(!ok){visibility="SOURCE_UNAVAILABLE";content=null;claims=List.of();citations=List.of();}
        }
        return new MessageView(msg.id(),msg.role(),content,msg.answerStatus(),visibility,
            List.copyOf(claims),List.copyOf(citations),msg.createdAt());
    }

    private List<Map<String,Object>> safeContext(UUID meeting,AssistantStore.Turn turn){
        List<AssistantStore.Message> prior=store.context(turn.conversationId(),turn.id());
        Collections.reverse(prior);
        List<Map<String,Object>> result=new ArrayList<>();
        for(var msg:prior){
            if("ASSISTANT".equals(msg.role())){
                MessageView safe=view(msg,meeting);
                if(!"VISIBLE".equals(safe.visibility())){result.clear();continue;}
                result.add(Map.of("role","ASSISTANT","content",safe.content(),
                    "scopeId",turn.conversationId().toString(),"scopeVersion",turn.scopeVersion()));
            } else if("USER".equals(msg.role())){
                result.add(Map.of("role","USER","content",msg.content(),
                    "scopeId",turn.conversationId().toString(),"scopeVersion",turn.scopeVersion()));
            }
        }
        return List.copyOf(result.subList(Math.max(0,result.size()-6),result.size()));
    }

    private String request(AssistantStore.Conversation conversation,UUID user,AssistantStore.Turn turn,
                           String question,List<Map<String,Object>> context) throws Exception {
        OffsetDateTime now=OffsetDateTime.now(ZoneOffset.UTC);
        Map<String,Object> scope=new LinkedHashMap<>();
        scope.put("contractVersion","1.0");
        scope.put("scopeId",conversation.id().toString());
        scope.put("principalId",user.toString());
        scope.put("scopeVersion",turn.scopeVersion());
        scope.put("issuedAt",now.toString());
        scope.put("expiresAt",now.plusSeconds(90).toString());
        scope.put("authority","CORE_APPROVED");
        scope.put("allowedMeetingIds",List.of(conversation.meetingId().toString()));
        scope.put("allowedSourceIds",List.of());
        scope.put("allowedSourceTypes",List.of());
        return json.writeValueAsString(Map.of(
            "contractVersion","1.0","requestId",turn.id().toString(),"question",question,
            "authorizedScope",scope,"conversationContext",context));
    }
    private static String version(UUID meeting,UUID owner){
        String hash=WorkerJson.sha256(("assistant-v1:"+meeting+":"+owner).getBytes(StandardCharsets.UTF_8));
        return "v1-"+hash.substring(0,32);
    }
    private static ValidatedAnswer failed(){
        return new ValidatedAnswer("FAILED","Assistant is temporarily unavailable.",
            WorkerJson.MAPPER.createArrayNode(),WorkerJson.MAPPER.createObjectNode(),null,List.of(),List.of());
    }
    private static void validatePage(int page,int size){
        if(page<0||page>10_000||size<1||size>50)
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }
    private record Admission(AssistantStore.Turn turn,boolean execute){}
}
