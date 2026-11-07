package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

/** Outbound delivery cannot be enabled by accidentally toggling only its flag. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
    "app.notification.action-item-assignment-enabled=false",
    "app.notification.action-item-assignment-delivery-enabled=true",
    "app.email.delivery.worker-enabled=false"
})
class ActionItemDeliveryGateFailClosedIntegrationTests {
    @Autowired List<TransactionalEmailHandler> handlers;

    @Test
    void outboundAssignmentHandlerRequiresBothExplicitFeatureGates() {
        assertThat(handlers).noneMatch(
            handler -> "ACTION_ITEM_ASSIGNED".equals(handler.notificationType()));
    }
}
