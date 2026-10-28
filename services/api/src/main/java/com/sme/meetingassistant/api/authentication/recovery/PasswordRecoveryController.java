package com.sme.meetingassistant.api.authentication.recovery;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.authentication.abuse.TrustedClientSource;
import com.sme.meetingassistant.api.authentication.abuse.AuthSecurityEventRecorder;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** Dedicated anonymous capability flow, no authentication-cookie or access-JWT dependency. */
@RestController
@RequestMapping("/api/v1/auth")
@ConditionalOnProperty(prefix="app.auth.recovery",name="enabled",havingValue="true")
public class PasswordRecoveryController {
    private final PasswordRecoveryService service;
    private final TrustedClientSource source;
    private final AuthSecurityEventRecorder audit;
    private final ApiResponseFactory responses;

    public PasswordRecoveryController(PasswordRecoveryService service,ApiResponseFactory responses,
            TrustedClientSource source,AuthSecurityEventRecorder audit) {
        this.service=service;this.responses=responses;this.source=source;this.audit=audit;
    }
    public record RecoveryRequest(String email) {}
    public record ResetRequest(@NotBlank String token,@NotBlank String password) {}
    public record NeutralAcknowledgement(String message) {}

    @PostMapping("/password-recovery")
    public ResponseEntity<ApiResponse<NeutralAcknowledgement>> request(
            @RequestBody RecoveryRequest data,HttpServletRequest request) {
        service.request(data==null?null:data.email(),source.from(request));
        audit.record(AuthSecurityEventRecorder.Action.RECOVERY_REQUEST_RECEIVED,null,null);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(new NeutralAcknowledgement(
                "If the account is eligible, a password recovery email will be sent.")));
    }

    @PostMapping("/password-reset")
    public ResponseEntity<ApiResponse<NeutralAcknowledgement>> reset(
            @Valid @RequestBody ResetRequest data) {
        service.reset(data.token(),data.password());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(new NeutralAcknowledgement(
                "Password updated. Please sign in again.")));
    }
}
