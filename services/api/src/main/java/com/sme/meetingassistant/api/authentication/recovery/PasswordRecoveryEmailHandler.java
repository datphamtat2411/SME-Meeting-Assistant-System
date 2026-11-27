package com.sme.meetingassistant.api.authentication.recovery;

import com.sme.meetingassistant.api.config.ApplicationPageUrlPolicy;
import com.sme.meetingassistant.api.config.RuntimeProperties;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import java.net.URI;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Purpose-bound recovery email; rechecks token/account/recipient on every SMTP attempt. */
@Component
@ConditionalOnProperty(prefix="app.auth.recovery",name="enabled",havingValue="true")
public class PasswordRecoveryEmailHandler implements TransactionalEmailHandler {
    private final JdbcTemplate jdbc;
    private final RecoveryCapabilityCodec codec;
    private final URI destination;
    public PasswordRecoveryEmailHandler(JdbcTemplate jdbc, RecoveryCapabilityCodec codec,
            @Value("${app.auth.recovery.reset-url:}") String configuredUrl,
            RuntimeProperties runtimeProperties) {
        this.jdbc=jdbc;
        this.codec=codec;
        try {
            destination=ApplicationPageUrlPolicy.validate(
                configuredUrl, runtimeProperties.getEnvironment(), "Password recovery");
        } catch(RuntimeException invalid) {
            throw new IllegalStateException(
                "Password recovery link requires an approved HTTPS page or a loopback HTTP development page");
        }
    }
    @Override public String notificationType() {return "PASSWORD_RECOVERY";}
    @Override public Optional<Content> compose(UUID tokenId,String recipientEmail) {
        if(tokenId==null || recipientEmail==null) return Optional.empty();
        var rows=jdbc.query("""
          SELECT t.delivery_nonce
            FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
           WHERE t.id=? AND t.expires_at>clock_timestamp()
             AND t.used_at IS NULL AND t.revoked_at IS NULL
             AND u.account_status='ACTIVE' AND u.email=? AND u.password_hash LIKE '$argon2id$%'
          """,(rs,n)->rs.getBytes("delivery_nonce"),tokenId,recipientEmail);
        if(rows.size()!=1 || rows.getFirst()==null) return Optional.empty();
        String link=destination+"#token="+codec.issue(tokenId,rows.getFirst());
        return Optional.of(new Content("Reset your SME Meeting Assistant password",
            "A password reset was requested for your account. This one-time link expires within 30 minutes:\n"
             + link+"\nIf you did not request a reset, ignore this email."));
    }
}
