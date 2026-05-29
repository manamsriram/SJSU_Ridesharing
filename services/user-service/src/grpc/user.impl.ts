import * as grpc from '@grpc/grpc-js';
import type { UserServiceServer, GetUserRequest, UserResponse } from '../../../../../shared/generated/user';
import { getUserById } from '../services/user.service';

export const userImpl: UserServiceServer = {
  async getUser(
    call: grpc.ServerUnaryCall<GetUserRequest, UserResponse>,
    callback: grpc.sendUnaryData<UserResponse>
  ) {
    try {
      const user = await getUserById(call.request.userId);
      if (!user) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: `User ${call.request.userId} not found`,
        });
        return;
      }
      callback(null, {
        userId: user.user_id,
        email: user.email,
        name: user.name,
        role: user.role,
        sjsuIdStatus: user.sjsu_id_status,
      });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },
};
