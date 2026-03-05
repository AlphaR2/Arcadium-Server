// import { User } from 'src/auth/entities/user.entity';

export default {};

declare module 'express' {
  interface Request {
    user: User;
  }
}
