package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.assistant.AssistantModels.*;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.List;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/assistant/conversations")
final class AssistantController {
    private final AssistantService service;
    private final ApiResponseFactory responses;
    AssistantController(AssistantService service,ApiResponseFactory responses) {
        this.service=service;this.responses=responses;
    }
    @GetMapping
    ResponseEntity<ApiResponse<List<ConversationView>>> list(
            @RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="20") int size){
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(service.list(page,size)));
    }
    @PostMapping
    ResponseEntity<ApiResponse<ConversationView>> create(@Valid @RequestBody CreateConversation input){
        ConversationView view=service.create(input);
        return ResponseEntity.created(URI.create("/api/v1/assistant/conversations/"+view.id()))
            .cacheControl(CacheControl.noStore()).header("Referrer-Policy","no-referrer")
            .body(responses.success(view));
    }
    @GetMapping("/{conversationId}")
    ResponseEntity<ApiResponse<ConversationDetail>> detail(@PathVariable UUID conversationId,
            @RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="50") int size){
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("Referrer-Policy","no-referrer")
            .body(responses.success(service.detail(conversationId,page,size)));
    }
    @PostMapping("/{conversationId}/messages")
    ResponseEntity<ApiResponse<TurnView>> submit(@PathVariable UUID conversationId,
           @RequestHeader("Idempotency-Key") String key,@Valid @RequestBody Ask input){
        TurnOutcome outcome=service.submit(conversationId,key,input);
        if(outcome.httpStatus()==503){
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .cacheControl(CacheControl.noStore()).header("Referrer-Policy","no-referrer")
                .body(responses.error("ASSISTANT_UNAVAILABLE","Assistant answer is unavailable.",null));
        }
        if(outcome.httpStatus()==409){
            return ResponseEntity.status(HttpStatus.CONFLICT).cacheControl(CacheControl.noStore())
                .body(responses.error("ASSISTANT_SOURCE_STALE",
                    "Assistant evidence is no longer current.",null));
        }
        return ResponseEntity.status(outcome.httpStatus())
            .cacheControl(CacheControl.noStore()).header("Referrer-Policy","no-referrer")
            .body(responses.success(outcome.result()));
    }
}
