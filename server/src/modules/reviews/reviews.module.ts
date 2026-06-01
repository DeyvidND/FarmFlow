import { Module } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { PublicReviewsController, ReviewsController } from './reviews.controller';

@Module({
  controllers: [PublicReviewsController, ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
