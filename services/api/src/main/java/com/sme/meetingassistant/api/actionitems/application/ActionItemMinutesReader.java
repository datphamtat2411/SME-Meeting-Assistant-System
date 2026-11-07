package com.sme.meetingassistant.api.actionitems.application;

import com.sme.meetingassistant.api.actionitems.ActionItemService;
import com.sme.meetingassistant.api.actionitems.ActionItemStatus;
import com.sme.meetingassistant.api.actionitems.ActionItemView;
import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Reuses the canonical Action Items service with its current data and permissions. */
@Service
public class ActionItemMinutesReader implements ActionItemMinutesSource {
    private static final int PAGE_SIZE = 100;
    private static final int MAX_ITEMS = 2000;
    private final ActionItemService items;
    private final MeetingMediaAccess meetingAccess;
    private final AuthenticatedUserId principal;

    public ActionItemMinutesReader(ActionItemService items, MeetingMediaAccess meetingAccess,
            AuthenticatedUserId principal) {
        this.items = items;
        this.meetingAccess = meetingAccess;
        this.principal = principal;
    }

    @Override
    @Transactional(readOnly = true)
    public List<ActionItemView> officialForMeeting(UUID meetingId) {
        UUID actor = principal.requireUserId();
        // The Action Item service allows external assignees and managers; Minutes
        // must be STRICTER. Content read is independently required here.
        meetingAccess.requireReadable(meetingId, actor);
        List<ActionItemView> official = new ArrayList<>();
        for (int page = 0; page <= MAX_ITEMS / PAGE_SIZE; page++) {
            var batch = items.list(actor, meetingId, null, null, null, null,
                    PageRequest.of(page, PAGE_SIZE, Sort.by(Sort.Direction.ASC, "createdAt")));
            if (batch.getTotalElements() > MAX_ITEMS) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Minutes Action Item count exceeds safe export limit");
            }
            for (ActionItemView item : batch.getContent()) {
                if (item.status() != ActionItemStatus.PROPOSED
                        && ("MANUAL".equals(item.sourceType())
                        || item.confirmedByUserId() != null)) {
                    official.add(item);
                }
            }
            if (!batch.hasNext()) break;
        }
        return List.copyOf(official);
    }
}
