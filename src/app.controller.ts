import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import * as fs from 'fs';
import * as path from 'path';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check — returns service uptime and status' })
  @ApiResponse({
    status: 200,
    description: 'Service is healthy',
    schema: {
      properties: {
        status: { type: 'string', example: 'ok' },
        uptime: { type: 'number', example: 42.5 },
        timestamp: { type: 'string', example: '2025-01-01T00:00:00.000Z' },
      },
    },
  })
  getHealth() {
    return this.appService.getHealth();
  }

  /**
   * Serves the Envoy agent SKILL.md file.
   * Paste this URL into your AI to teach it how to handle bounty dispatches.
   * Public — no auth required so any AI can fetch it.
   * URL: GET https://your-api.railway.app/skill.md
   */
  @Get('skill.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @ApiOperation({ summary: 'Envoy agent SKILL.md — paste this URL into your AI' })
  @ApiResponse({ status: 200, description: 'SKILL.md content in markdown' })
  getSkill(): string {
    return fs.readFileSync(path.join(process.cwd(), 'SKILL.md'), 'utf-8');
  }
}
