package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.OutboxEventEntity;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OutboxEventRepository extends JpaRepository<OutboxEventEntity, UUID> {
}
