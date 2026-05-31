import { Module } from '@nestjs/common';
import { ArticlesService } from './articles.service';
import { ArticlesCacheService } from './articles-cache.service';
import { ArticlesController, PublicArticlesController } from './articles.controller';

@Module({
  controllers: [ArticlesController, PublicArticlesController],
  providers: [ArticlesService, ArticlesCacheService],
})
export class ArticlesModule {}
