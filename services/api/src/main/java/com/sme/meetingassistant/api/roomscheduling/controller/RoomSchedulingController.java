package com.sme.meetingassistant.api.roomscheduling.controller;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.roomscheduling.dto.RoomDtos;
import com.sme.meetingassistant.api.roomscheduling.service.RoomSchedulingService;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import jakarta.validation.Valid;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v1/organizations/{organizationId}")
public class RoomSchedulingController {
    private final RoomSchedulingService service;private final AuthenticatedUserId caller;private final ApiResponseFactory responses;
    public RoomSchedulingController(RoomSchedulingService service,AuthenticatedUserId caller,ApiResponseFactory responses){this.service=service;this.caller=caller;this.responses=responses;}
    @PostMapping("/rooms") @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<RoomDtos.Room> createRoom(@PathVariable UUID organizationId,@Valid @RequestBody RoomDtos.CreateRoom request,Principal principal){return responses.success(service.createRoom(organizationId,caller.from(principal),request));}
    @GetMapping("/rooms") public ApiResponse<List<RoomDtos.Room>> listRooms(@PathVariable UUID organizationId,Principal principal){return responses.success(service.listRooms(organizationId,caller.from(principal)));}
    @PatchMapping("/rooms/{roomId}") public ApiResponse<RoomDtos.Room> updateRoom(@PathVariable UUID organizationId,@PathVariable UUID roomId,@Valid @RequestBody RoomDtos.UpdateRoom request,Principal principal){return responses.success(service.updateRoom(organizationId,roomId,caller.from(principal),request));}
    @DeleteMapping("/rooms/{roomId}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void disableRoom(@PathVariable UUID organizationId,@PathVariable UUID roomId,Principal principal){service.disableRoom(organizationId,roomId,caller.from(principal));}
    @PostMapping("/rooms/{roomId}/reservations") @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<RoomDtos.Reservation> reserve(@PathVariable UUID organizationId,@PathVariable UUID roomId,@Valid @RequestBody RoomDtos.Reserve request,Principal principal){return responses.success(service.reserve(organizationId,roomId,caller.from(principal),request));}
    @GetMapping("/rooms/{roomId}/reservations") public ApiResponse<List<RoomDtos.Reservation>> reservations(@PathVariable UUID organizationId,@PathVariable UUID roomId,Principal principal){return responses.success(service.listReservations(organizationId,roomId,caller.from(principal)));}
    @DeleteMapping("/reservations/{reservationId}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void cancel(@PathVariable UUID organizationId,@PathVariable UUID reservationId,Principal principal){service.cancelReservation(organizationId,reservationId,caller.from(principal));}
}
