import * as grpc from '@grpc/grpc-js';
import { BookingServiceClient } from './generated/booking';
import { CostServiceClient } from './generated/cost';
import { NotificationServiceClient } from './generated/notification';
import { PaymentServiceClient } from './generated/payment';
import { config } from './config';

const creds = grpc.credentials.createInsecure();

let _booking: BookingServiceClient | null = null;
let _cost: CostServiceClient | null = null;
let _notification: NotificationServiceClient | null = null;
let _payment: PaymentServiceClient | null = null;

export const getBookingClient = (): BookingServiceClient => {
  if (!_booking) _booking = new BookingServiceClient(config.bookingGrpcHost, creds);
  return _booking;
};

export const getCostClient = (): CostServiceClient => {
  if (!_cost) _cost = new CostServiceClient(config.costGrpcHost, creds);
  return _cost;
};

export const getNotificationClient = (): NotificationServiceClient => {
  if (!_notification) _notification = new NotificationServiceClient(config.notificationGrpcHost, creds);
  return _notification;
};

export const getPaymentClient = (): PaymentServiceClient => {
  if (!_payment) _payment = new PaymentServiceClient(config.paymentGrpcHost, creds);
  return _payment;
};

export function unary<Req, Res = any>(
  fn: (req: Req, cb: (err: grpc.ServiceError | null, res: Res) => void) => any,
  req: Req,
): Promise<Res> {
  return new Promise((resolve, reject) =>
    fn(req, (err, res) => (err ? reject(err) : resolve(res))),
  );
}
