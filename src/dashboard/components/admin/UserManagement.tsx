import React, { useState, useEffect } from 'react';
import {
    Box,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TablePagination,
    Button,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Select,
    MenuItem,
    FormControl,
    InputLabel,
    IconButton,
    Tooltip,
    Alert
} from '@mui/material';
import {
    Edit as EditIcon,
    Delete as DeleteIcon,
    Lock as LockIcon,
    LockOpen as UnlockIcon
} from '@mui/icons-material';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { UserService } from '../../services/UserService';
import { RoleService } from '../../services/RoleService';
import { User, Role } from '../../types';

export const UsersManagement: React.FC = () => {
    const { currentUser } = useAuth();
    const { hasPermission } = usePermissions();
    const [users, setUsers] = useState<User[]>([]);
    const [roles, setRoles] = useState<Role[]>([]);
    const [page, setPage] = useState(0);
    const [rowsPerPage, setRowsPerPage] = useState(10);
    const [editUser, setEditUser] = useState<User | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        loadUsers();
        loadRoles();
    }, []);

    const loadUsers = async () => {
        try {
            const response = await UserService.getAllUsers();
            setUsers(response.data);
        } catch (err) {
            setError('Failed to load users');
        }
    };

    const loadRoles = async () => {
        try {
            const response = await RoleService.getAllRoles();
            setRoles(response.data);
        } catch (err) {
            setError('Failed to load roles');
        }
    };

    const handleEditUser = (user: User) => {
        setEditUser(user);
        setIsDialogOpen(true);
    };

    const handleUpdateUser = async (updatedUser: User) => {
        try {
            await UserService.updateUser(updatedUser.id, updatedUser);
            setIsDialogOpen(false);
            loadUsers();
        } catch (err) {
            setError('Failed to update user');
        }
    };

    const handleToggleUserStatus = async (userId: string, isActive: boolean) => {
        try {
            await UserService.updateUserStatus(userId, isActive);
            loadUsers();
        } catch (err) {
            setError('Failed to update user status');
        }
    };

    const handleDeleteUser = async (userId: string) => {
        if (window.confirm('Are you sure you want to delete this user?')) {
            try {
                await UserService.deleteUser(userId);
                loadUsers();
            } catch (err) {
                setError('Failed to delete user');
            }
        }
    };

    return (
        <Box sx={{ width: '100%', p: 3 }}>
            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}
            
            <Paper sx={{ width: '100%', mb: 2 }}>
                <TableContainer>
                    <Table>
                        <TableHead>
                            <TableRow>
                                <TableCell>Username</TableCell>
                                <TableCell>Email</TableCell>
                                <TableCell>Role</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell>Last Login</TableCell>
                                <TableCell>Actions</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {users
                                .slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
                                .map((user) => (
                                    <TableRow key={user.id}>
                                        <TableCell>{user.username}</TableCell>
                                        <TableCell>{user.email}</TableCell>
                                        <TableCell>{user.role.name}</TableCell>
                                        <TableCell>
                                            {user.isActive ? 'Active' : 'Inactive'}
                                        </TableCell>
                                        <TableCell>
                                            {user.lastLoginAt ? 
                                                new Date(user.lastLoginAt).toLocaleString() : 
                                                'Never'}
                                        </TableCell>
                                        <TableCell>
                                            <Tooltip title="Edit User">
                                                <IconButton
                                                    onClick={() => handleEditUser(user)}
                                                    disabled={!hasPermission('MANAGE_USERS')}
                                                >
                                                    <EditIcon />
                                                </IconButton>
                                            </Tooltip>
                                            
                                            <Tooltip title={user.isActive ? 'Deactivate' : 'Activate'}>
                                                <IconButton
                                                    onClick={() => handleToggleUserStatus(user.id, !user.isActive)}
                                                    disabled={!hasPermission('MANAGE_USERS')}
                                                >
                                                    {user.isActive ? <LockIcon /> : <UnlockIcon />}
                                                </IconButton>
                                            </Tooltip>

                                            {currentUser?.role.name === 'SUPER_ADMIN' && (
                                                <Tooltip title="Delete User">
                                                    <IconButton
                                                        onClick={() => handleDeleteUser(user.id)}
                                                        color="error"
                                                    >
                                                        <DeleteIcon />
                                                    </IconButton>
                                                </Tooltip>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                </TableContainer>
                
                <TablePagination
                    component="div"
                    count={users.length}
                    page={page}
                    onPageChange={(_, newPage) => setPage(newPage)}
                    rowsPerPage={rowsPerPage}
                    onRowsPerPageChange={(event) => {
                        setRowsPerPage(parseInt(event.target.value, 10));
                        setPage(0);
                    }}
                />
            </Paper>

            <Dialog open={isDialogOpen} onClose={() => setIsDialogOpen(false)}>
                <DialogTitle>Edit User</DialogTitle>
                <DialogContent>
                    {editUser && (
                        <Box sx={{ pt: 2 }}>
                            <TextField
                                fullWidth
                                label="Username"
                                value={editUser.username}
                                onChange={(e) => setEditUser({
                                    ...editUser,
                                    username: e.target.value
                                })}
                                sx={{ mb: 2 }}
                            />
                            
                            <FormControl fullWidth sx={{ mb: 2 }}>
                                <InputLabel>Role</InputLabel>
                                <Select
                                    value={editUser.role.id}
                                    onChange={(e) => setEditUser({
                                        ...editUser,
                                        role: roles.find(r => r.id === e.target.value)!
                                    })}
                                >
                                    {roles.map((role) => (
                                        <MenuItem key={role.id} value={role.id}>
                                            {role.name}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                    <Button 
                        onClick={() => editUser && handleUpdateUser(editUser)}
                        variant="contained"
                    >
                        Save
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};
