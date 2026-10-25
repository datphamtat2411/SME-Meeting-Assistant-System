package com.sme.meetingassistant.api.transcript.repository;

import com.sme.meetingassistant.api.transcript.entity.TranscriptSegmentEntity;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface TranscriptSegmentRepository extends JpaRepository<TranscriptSegmentEntity, UUID> {

	List<TranscriptSegmentEntity> findAllByTranscriptIdOrderBySequenceNumberAsc(UUID transcriptId);

	Optional<TranscriptSegmentEntity> findByIdAndTranscriptId(UUID id, UUID transcriptId);

}
