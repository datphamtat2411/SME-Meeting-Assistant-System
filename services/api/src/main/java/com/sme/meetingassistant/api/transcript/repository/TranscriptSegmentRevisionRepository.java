package com.sme.meetingassistant.api.transcript.repository;

import com.sme.meetingassistant.api.transcript.entity.TranscriptSegmentRevisionEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface TranscriptSegmentRevisionRepository extends JpaRepository<TranscriptSegmentRevisionEntity, UUID> {

	List<TranscriptSegmentRevisionEntity> findAllBySegmentIdOrderByRevisionNumberDesc(UUID segmentId);

	@Query("select coalesce(max(r.revisionNumber), 0) from TranscriptSegmentRevisionEntity r where r.segmentId = :segmentId")
	int findMaxRevisionNumber(@Param("segmentId") UUID segmentId);

}
