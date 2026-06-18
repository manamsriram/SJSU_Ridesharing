import express from 'express';
import * as bookingController from '../controllers/booking.controller';
import * as bookingService from '../services/booking.service';
import { authenticateToken, requireVerifiedStudent, requireInternalService, asyncHandler } from '@lessgo/shared';
import { body, validationResult } from 'express-validator';

const router = express.Router();

const validateRequest = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }

  return res.status(400).json({
    status: 'error',
    message: 'Validation failed',
    errors: errors.array().map((e) => ({
      field: 'path' in e ? e.path : undefined,
      message: e.msg,
    })),
  });
};

router.post(
  '/',
  authenticateToken,
  requireVerifiedStudent,
  [
    body('trip_id').notEmpty().withMessage('Trip ID is required').isUUID(),
    body('seats_booked').isInt({ min: 1, max: 8 }).withMessage('Seats booked must be 1-8'),
  ],
  validateRequest,
  asyncHandler(bookingController.createBooking)
);

// Internal route to create a booking on behalf of a rider (used by matching flow)
router.post(
  '/internal',
  [
    body('trip_id').notEmpty().withMessage('Trip ID is required').isUUID(),
    body('rider_id').notEmpty().withMessage('Rider ID is required').isUUID(),
    body('seats_booked').isInt({ min: 1, max: 8 }).withMessage('Seats booked must be 1-8'),
  ],
  requireInternalService,
  validateRequest,
  asyncHandler(async (req: express.Request, res: express.Response) => {
    const { rider_id, ...bookingData } = req.body;
    const result = await bookingService.createBooking(rider_id, bookingData);
    res.status(201).json({ status: 'success', data: result, message: 'Booking created successfully' });
  })
);

router.get('/', authenticateToken, asyncHandler(bookingController.listBookings));

router.get('/:id', asyncHandler(bookingController.getBooking));

router.put('/:id/confirm', authenticateToken, asyncHandler(bookingController.confirmBooking));

router.put('/:id/cancel', authenticateToken, asyncHandler(bookingController.cancelBooking));

router.post('/:id/confirm-pickup', authenticateToken, asyncHandler(bookingController.confirmPickup));

router.post('/:id/confirm-dropoff', authenticateToken, asyncHandler(bookingController.confirmDropoff));

router.patch('/:id/approve', authenticateToken, asyncHandler(bookingController.approveBooking));

router.patch('/:id/reject', authenticateToken, asyncHandler(bookingController.rejectBooking));

router.post('/:id/authorize-payment', authenticateToken, asyncHandler(bookingController.authorizePayment));

router.post('/:id/confirm-payment', authenticateToken, asyncHandler(bookingController.confirmPayment));

router.post('/:id/capture-payment', authenticateToken, asyncHandler(bookingController.capturePayment));

router.delete('/:id/payment-intent', authenticateToken, asyncHandler(bookingController.deletePaymentIntent));

router.delete('/:id', authenticateToken, asyncHandler(bookingController.deleteBooking));

router.post(
  '/:id/rate',
  authenticateToken,
  [
    body('score').isInt({ min: 1, max: 5 }).withMessage('Score must be 1-5'),
    body('comment').optional().trim(),
  ],
  validateRequest,
  asyncHandler(bookingController.createRating)
);

router.put(
  '/:id/pickup-location',
  authenticateToken,
  [
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
    body('address').optional().trim(),
  ],
  validateRequest,
  asyncHandler(bookingController.updatePickupLocation)
);

router.get(
  '/trips/:tripId/bookings',
  authenticateToken,
  asyncHandler(bookingController.getTripBookings)
);

router.get(
  '/trip/:tripId',
  authenticateToken,
  asyncHandler(bookingController.getTripBookings)
);

// Internal service-to-service route used by cost-calculation-service for settlement.
// Authenticated with the shared internal-service token (not exposed via gateway).
router.get(
  '/trip/:tripId/settle',
  requireInternalService,
  asyncHandler(async (req: express.Request, res: express.Response) => {
    const bookings = await bookingService.getBookingsByTripId(req.params.tripId);
    res.json({ status: 'success', data: bookings });
  })
);

// Internal: batch-freeze discounted per-rider settlements at the T-1h checkpoint.
// Called by trip-service's discount-freeze job with amounts from the cost service.
router.post(
  '/trip/:tripId/freeze-settlements',
  requireInternalService,
  asyncHandler(async (req: express.Request, res: express.Response) => {
    const { riders } = req.body;
    if (!Array.isArray(riders)) {
      res.status(400).json({ status: 'error', message: 'riders array is required' });
      return;
    }
    const result = await bookingService.freezeBookingSettlements(riders);
    res.json({ status: 'success', data: result, message: 'Settlements frozen' });
  })
);

// Internal: write final_price to quotes table after settlement.
// Called by trip-service on trip completion.
router.patch(
  '/:id/final-price',
  requireInternalService,
  asyncHandler(async (req: express.Request, res: express.Response) => {
    const { final_price } = req.body;
    if (typeof final_price !== 'number' || final_price <= 0) {
      res.status(400).json({ status: 'error', message: 'final_price must be a positive number' });
      return;
    }
    await bookingService.writeFinalPrice(req.params.id, final_price);
    res.json({ status: 'success', message: 'final_price updated' });
  })
);

export default router;
