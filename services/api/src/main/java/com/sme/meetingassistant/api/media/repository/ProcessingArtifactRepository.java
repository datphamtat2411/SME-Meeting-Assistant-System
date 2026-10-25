package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.ProcessingArtifactEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProcessingArtifactRepository extends JpaRepository<ProcessingArtifactEntity, UUID> {

    List<ProcessingArtifactEntity> findAllByJobIdOrderByCreatedAtAsc(UUID jobId);

}
