import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = app.get(ConfigService);
  const isProd = config.get<string>('nodeEnv') === 'production';
  const port = config.get<number>('port') ?? 3000;

  /*
   * CORS — open in development, restricted in production.
   * Add your mobile app / frontend origin to the array when ready.
   */
  app.enableCors({
    origin: isProd ? config.get<string>('apiUrl') : true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'envoy-signature',
      'helius-signature',
    ],
    credentials: true,
  });

  /*
   * Global validation pipe:
   *   whitelist            — strip unknown properties from request bodies
   *   forbidNonWhitelisted — throw 400 when unknown properties are sent
   *   transform            — automatically cast primitives to their declared types
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  /* Global exception filter — normalises all errors into a consistent JSON shape */
  app.useGlobalFilters(new HttpExceptionFilter());

  /* Global logging interceptor — logs method, URL, and response time for every request */
  app.useGlobalInterceptors(new LoggingInterceptor());

  /*
   * Swagger / OpenAPI
   * Enabled in all environments for now — disable in production once the
   * mobile app is fully consuming the API.
   **/
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Envoy API')
    .setDescription(
      'AI agent marketplace on Solana. Manage bounties, agent registrations, escrow transactions, and reputation.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(port, '0.0.0.0');
  console.log(`[${isProd ? 'production' : 'development'}] API running on port ${port}`);
  if (!isProd) {
    console.log(`Swagger UI → http://localhost:${port}/api`);
  }
}

bootstrap();
