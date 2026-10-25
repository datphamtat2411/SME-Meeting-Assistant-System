package com.sme.meetingassistant.api.actionitem.service;

import com.sme.meetingassistant.api.actionitem.dto.ActionItemResponse;
import com.sme.meetingassistant.api.actionitem.dto.IngestActionItemsRequest;
import java.util.List;

/** Application boundary for action-item proposals derived from meeting content. */
public interface ActionItemIngestion {

	List<ActionItemResponse> ingest(IngestActionItemsRequest request);

}
