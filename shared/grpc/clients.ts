// shared/grpc/clients.ts
import * as grpc from '@grpc/grpc-js';
import { BookingServiceClient } from '../generated/booking';
import { CostServiceClient } from '../generated/cost';
import { EmbeddingServiceClient } from '../generated/embedding';
import { NotificationServiceClient } from '../generated/notification';
import { PaymentServiceClient } from '../generated/payment';
import { RoutingServiceClient } from '../generated/routing';
import { TripServiceClient } from '../generated/trip';
import { UserServiceClient } from '../generated/user';

const insecure = grpc.credentials.createInsecure();

/** @param url - host:port of the booking gRPC server */
export const createBookingClient = (url: string): BookingServiceClient =>
  new BookingServiceClient(url, insecure);

/** @param url - host:port of the cost-calculation gRPC server */
export const createCostClient = (url: string): CostServiceClient =>
  new CostServiceClient(url, insecure);

/** @param url - host:port of the embedding gRPC server */
export const createEmbeddingClient = (url: string): EmbeddingServiceClient =>
  new EmbeddingServiceClient(url, insecure);

/** @param url - host:port of the notification gRPC server */
export const createNotificationClient = (url: string): NotificationServiceClient =>
  new NotificationServiceClient(url, insecure);

/** @param url - host:port of the payment gRPC server */
export const createPaymentClient = (url: string): PaymentServiceClient =>
  new PaymentServiceClient(url, insecure);

/** @param url - host:port of the routing gRPC server */
export const createRoutingClient = (url: string): RoutingServiceClient =>
  new RoutingServiceClient(url, insecure);

/** @param url - host:port of the trip gRPC server */
export const createTripClient = (url: string): TripServiceClient =>
  new TripServiceClient(url, insecure);

/** @param url - host:port of the user gRPC server */
export const createUserClient = (url: string): UserServiceClient =>
  new UserServiceClient(url, insecure);
