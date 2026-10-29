package com.sme.meetingassistant.api.userorganization.setup;

import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import java.net.URI;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Dedicated ACCOUNT_SETUP purpose-token renderer for the shared delivery worker. */
@Component
public final class AccountSetupEmailHandler implements TransactionalEmailHandler {
    private final JdbcTemplate jdbc;
    private final AccountSetupTokenCodec tokens;
    private final String setupUrl;

    public AccountSetupEmailHandler(JdbcTemplate jdbc, AccountSetupTokenCodec tokens,
            @Value("${app.account-setup.setup-url:}") String setupUrl) {
        this.jdbc = jdbc;
        this.tokens = tokens;
        this.setupUrl = setupUrl;
    }

    @Override
    public String notificationType() { return "ACCOUNT_SETUP"; }

    @Override
    public Optional<Content> compose(UUID tokenId, String recipientEmail) {
        if (tokenId == null) return Optional.empty();
        Integer count = jdbc.queryForObject("""
            SELECT COUNT(*) FROM account_setup_tokens t
              JOIN users u ON u.id=t.user_id
             WHERE t.id=? AND t.expires_at>clock_timestamp()
               AND t.used_at IS NULL AND t.revoked_at IS NULL
               AND u.account_status='PENDING_SETUP'
               AND u.email=?
            """, Integer.class, tokenId, recipientEmail);
        if (count == null || count != 1) return Optional.empty();

        URI destination = URI.create(setupUrl);
        if (!"https".equalsIgnoreCase(destination.getScheme()) || destination.getHost() == null
                || destination.getUserInfo() != null || destination.getFragment() != null
                || destination.getRawQuery() != null) {
            throw new IllegalStateException("Setup destination is not an approved HTTPS page");
        }
        String link = destination + "#token=" + tokens.issue(tokenId);
        return Optional.of(new Content("Complete your SME Meeting Assistant account setup",
            "Set your account password using this one-time link (expires within 24 hours):\n"
            + link + "\nIf you did not expect this invitation, please disregard it."));
    }
}
