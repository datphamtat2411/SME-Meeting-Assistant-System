package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.dto.UserDtos;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.util.Locale;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Read-only meeting invite directory; this is not an administrative user listing. */
@Service
public class MeetingParticipantCandidateService {
    private static final int MAX_PAGE_SIZE = 20;

    private final OrganizationalAuthorizationService authorization;
    private final UserRepository users;

    public MeetingParticipantCandidateService(OrganizationalAuthorizationService authorization,
            UserRepository users) {
        this.authorization = authorization;
        this.users = users;
    }

    @Transactional(readOnly = true)
    public Page<UserDtos.MeetingParticipantCandidateView> list(String query, int page, int size) {
        var actor = authorization.requireActiveActor();
        if (page < 0 || size < 1 || size > MAX_PAGE_SIZE) throw invalid();
        String pattern = searchPattern(query);
        return users.findMeetingParticipantCandidates(actor.getId(), pattern, PageRequest.of(page, size))
            .map(candidate -> new UserDtos.MeetingParticipantCandidateView(
                candidate.getId(), candidate.getDisplayName(), candidate.getEmail(),
                candidate.getOrganizationalUnitName()));
    }

    private static String searchPattern(String query) {
        if (query == null) throw invalid();
        String normalized = query.strip();
        long nonWhitespace = normalized.codePoints()
            .filter(codePoint -> !Character.isWhitespace(codePoint)).count();
        if (nonWhitespace < 2) throw invalid();
        return "%" + normalized.toLowerCase(Locale.ROOT)
            .replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_") + "%";
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }
}
